#include <WiFi.h>
#include <LittleFS.h>
#include <ESPAsyncWebServer.h>
#include <ArduinoJson.h>
#include <ESPmDNS.h>

// ══════════════════════════════════════════
//  CONFIGURATION
// ══════════════════════════════════════════
#define DATA_FILE          "/wifi_data.csv"
#define SCAN_INTERVAL_MS   30000
#define WIFI_SSID          "R-113"
#define WIFI_PASS          "12345678"
#define MDNS_HOSTNAME      "wifi-scanner-ghost"
#define MAX_KNOWN_BSSIDS   128  // Safely limits RTC SRAM usage

// ══════════════════════════════════════════
//  GLOBALS
// ══════════════════════════════════════════
AsyncWebServer server(80);
bool serverStarted = false;
RTC_DATA_ATTR int totalScans = 0;
bool scanBusy = false;

// WiFi tracking
bool wifiWasConnected = false;

// ══════════════════════════════════════════
//  BSSID DEDUP TRACKER (survives deep sleep)
// ══════════════════════════════════════════
struct BssidEntry {
    char bssid[18];
    int rssi;
};
RTC_DATA_ATTR BssidEntry knownBSSIDs[MAX_KNOWN_BSSIDS];
RTC_DATA_ATTR int knownCount = 0;
RTC_DATA_ATTR int ringIndex = 0;

int findBSSID(const char* bssid) {
    for (int i = 0; i < knownCount; i++) {
        if (strcmp(knownBSSIDs[i].bssid, bssid) == 0) return i;
    }
    return -1;
}

void trackBSSID(const char* bssid, int rssi) {
    int idx = findBSSID(bssid);
    if (idx >= 0) {
        knownBSSIDs[idx].rssi = rssi;
        return;
    }
    
    // Ring buffer replacement logic
    int target = (knownCount < MAX_KNOWN_BSSIDS) ? knownCount : ringIndex;
    
    strncpy(knownBSSIDs[target].bssid, bssid, 17);
    knownBSSIDs[target].bssid[17] = '\0';
    knownBSSIDs[target].rssi = rssi;
    
    if (knownCount < MAX_KNOWN_BSSIDS) {
        knownCount++;
    } else {
        ringIndex = (ringIndex + 1) % MAX_KNOWN_BSSIDS;
    }
}

// ══════════════════════════════════════════
//  FILE SYSTEM & RECOVERY
// ══════════════════════════════════════════
bool fsReady = false;

void restoreKnownBSSIDs() {
    // If waking from deep sleep, RTC memory is intact, skip read
    if (knownCount > 0) return; 

    if (!fsReady || !LittleFS.exists(DATA_FILE)) return;
    
    File file = LittleFS.open(DATA_FILE, FILE_READ);
    if (!file) return;

    Serial.println("[FS] Restoring known BSSIDs from flash to prevent duplicates...");
    while (file.available()) {
        String line = file.readStringUntil('\n');
        line.trim();
        if (line.length() == 0) continue;
        
        // Parse CSV: timestamp,bssid,rssi,ssid,...
        int firstComma = line.indexOf(',');
        if (firstComma > 0) {
            int secondComma = line.indexOf(',', firstComma + 1);
            if (secondComma > firstComma) {
                String bssid = line.substring(firstComma + 1, secondComma);
                trackBSSID(bssid.c_str(), 0); // Re-populate RTC tracker
            }
        }
    }
    file.close();
    Serial.printf("[FS] Restored into ring buffer: %d active slots.\n", knownCount);
}

void initFS() {
    Serial.println("[FS] Mounting LittleFS...");
    if (!LittleFS.begin(true)) {
        Serial.println("[FS] ERROR: Mount failed!");
        return;
    }
    fsReady = true;
    Serial.printf("[FS] OK. Total: %u, Used: %u\n", LittleFS.totalBytes(), LittleFS.usedBytes());
    
    restoreKnownBSSIDs(); // Fill tracker array on fresh boot
}

String getEncryptionType(int encType) {
    switch (encType) {
        case WIFI_AUTH_OPEN:            return "OPEN";
        case WIFI_AUTH_WEP:             return "WEP";
        case WIFI_AUTH_WPA_PSK:         return "WPA";
        case WIFI_AUTH_WPA2_PSK:        return "WPA2";
        case WIFI_AUTH_WPA_WPA2_PSK:    return "WPA/WPA2";
        case WIFI_AUTH_WPA2_ENTERPRISE: return "WPA2-ENT";
        case WIFI_AUTH_WPA3_PSK:        return "WPA3";
        default:                        return "UNKNOWN";
    }
}

// ══════════════════════════════════════════
//  SCAN — synchronous, used everywhere
// ══════════════════════════════════════════
bool performScan() {
    if (scanBusy) {
        Serial.println("[SCAN] Already in progress.");
        return false;
    }

    scanBusy = true;
    Serial.printf("[SCAN] Starting... Free heap: %u\n", ESP.getFreeHeap());

    int n = WiFi.scanNetworks(false, true);

    if (n < 0) {
        Serial.printf("[SCAN] ERROR: returned %d\n", n);
        WiFi.scanDelete();
        scanBusy = false;
        return false;
    }

    Serial.printf("[SCAN] Found %d networks.\n", n);
    totalScans++;

    unsigned long scanTime = millis();
    int newEntries = 0;

    File file;
    if (fsReady) {
        file = LittleFS.open(DATA_FILE, FILE_APPEND);
    }

    for (int i = 0; i < n; i++) {
        String bssid = WiFi.BSSIDstr(i);
        int rssi = WiFi.RSSI(i);
        String ssid = WiFi.SSID(i);
        int channel = WiFi.channel(i);
        String enc = getEncryptionType(WiFi.encryptionType(i));

        int idx = findBSSID(bssid.c_str());
        bool isNew = (idx == -1);
        
        // FEATURE: Stop storing duplicate data.
        // We no longer trigger a write just because the signal (RSSI) fluctuated.
        bool changed = false; 

        if (isNew) {
            ssid.replace(",", " ");
            ssid.replace("\"", "'");
            ssid.replace("\n", "");
            ssid.replace("\r", "");

            if (file) {
                file.printf("%lu,%s,%d,%s,%d,%s\n", scanTime, bssid.c_str(), rssi, ssid.c_str(), channel, enc.c_str());
            }

            trackBSSID(bssid.c_str(), rssi);
            newEntries++;
            Serial.printf("[SCAN]   %s %s %-20s %ddBm ch%d %s\n",
                isNew ? "[NEW]" : "[UPD]", bssid.c_str(),
                (ssid.length() > 0 ? ssid.c_str() : "[Hidden]"), rssi, channel, enc.c_str());
        }
    }

    if (file) file.close();

    Serial.printf("[SCAN] Done: %d logged, %d/%d slots used.\n", newEntries, knownCount, MAX_KNOWN_BSSIDS);
    WiFi.scanDelete();
    scanBusy = false;
    return true;
}

// ══════════════════════════════════════════
//  CORS HELPER
// ══════════════════════════════════════════
void addCORS(AsyncWebServerResponse *r) {
    r->addHeader("Access-Control-Allow-Origin", "*");
    r->addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    r->addHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
}

// ══════════════════════════════════════════
//  WEB SERVER
// ══════════════════════════════════════════
void setupServer() {
    if (serverStarted) return;

    // CORS preflight
    server.onNotFound([](AsyncWebServerRequest *req) {
        if (req->method() == HTTP_OPTIONS) {
            auto *r = req->beginResponse(204);
            addCORS(r);
            req->send(r);
        } else {
            auto *r = req->beginResponse(404, "application/json", "{\"error\":\"Not Found\"}");
            addCORS(r);
            req->send(r);
        }
    });

    // GET / — API info
    server.on("/", HTTP_GET, [](AsyncWebServerRequest *req) {
        auto *r = req->beginResponse(200, "application/json",
            "{\"device\":\"ESP32 WiFi Scanner\",\"endpoints\":[\"/status\",\"/data\",\"/scan-and-fetch\",\"/clear\"]}");
        addCORS(r);
        req->send(r);
    });

    // GET /status — health check (lightweight, no scan)
    server.on("/status", HTTP_GET, [](AsyncWebServerRequest *req) {
        StaticJsonDocument<1024> doc;
        doc["uptime_ms"] = millis();
        doc["free_heap"] = ESP.getFreeHeap();
        doc["total_scans"] = totalScans;
        doc["scan_busy"] = scanBusy;
        doc["known_bssids"] = knownCount;
        doc["wifi_ssid"] = WIFI_SSID;
        doc["sta_ip"] = WiFi.localIP().toString();
        doc["sta_connected"] = (WiFi.status() == WL_CONNECTED);
        doc["sta_rssi"] = WiFi.RSSI();
        if (fsReady) {
            doc["fs_total"] = LittleFS.totalBytes();
            doc["fs_used"] = LittleFS.usedBytes();
        }
        String out;
        serializeJson(doc, out);
        auto *r = req->beginResponse(200, "application/json", out);
        addCORS(r);
        req->send(r);
    });

    // GET /data — stream raw CSV from flash
    server.on("/data", HTTP_GET, [](AsyncWebServerRequest *req) {
        Serial.println("[HTTP] GET /data");
        if (!fsReady || !LittleFS.exists(DATA_FILE)) {
            auto *r = req->beginResponse(200, "text/csv", "");
            addCORS(r);
            req->send(r);
            return;
        }
        auto *r = req->beginResponse(LittleFS, DATA_FILE, "text/csv");
        addCORS(r);
        req->send(r);
    });

    // POST /scan-and-fetch — scan then tell frontend to fetch /data
    server.on("/scan-and-fetch", HTTP_POST, [](AsyncWebServerRequest *req) {
        Serial.println("[HTTP] POST /scan-and-fetch");
        if (scanBusy) {
            auto *r = req->beginResponse(429, "application/json",
                "{\"status\":\"busy\",\"message\":\"Scan in progress\"}");
            addCORS(r);
            req->send(r);
            return;
        }

        bool ok = performScan();
        if (!ok) {
            auto *r = req->beginResponse(500, "application/json",
                "{\"status\":\"error\",\"message\":\"Scan failed\"}");
            addCORS(r);
            req->send(r);
            return;
        }

        auto *r = req->beginResponse(200, "application/json",
            "{\"status\":\"ok\",\"message\":\"Scan done, fetch /data\"}");
        addCORS(r);
        req->send(r);
    });

    // POST /clear — wipe all data
    server.on("/clear", HTTP_POST, [](AsyncWebServerRequest *req) {
        Serial.println("[HTTP] POST /clear");
        if (fsReady && LittleFS.exists(DATA_FILE)) {
            LittleFS.remove(DATA_FILE);
        }
        knownCount = 0;
        totalScans = 0;
        auto *r = req->beginResponse(200, "application/json",
            "{\"status\":\"ok\",\"message\":\"Data cleared\"}");
        addCORS(r);
        req->send(r);
    });

    server.begin();
    serverStarted = true;
    Serial.printf("[HTTP] Server started. Free heap: %u\n", ESP.getFreeHeap());
}

// ══════════════════════════════════════════
//  WIFI EVENT HANDLER
//  Registered BEFORE WiFi.begin() so every
//  event is caught. Runs inside the ESP-IDF
//  event task, which holds the TCPIP core
//  lock — the ONLY safe context to call
//  mDNS (prevents the tcp_alloc crash).
// ══════════════════════════════════════════
void onWiFiEvent(WiFiEvent_t event) {
    switch (event) {
        case ARDUINO_EVENT_WIFI_STA_GOT_IP:
            wifiWasConnected = true;
            Serial.printf("[WIFI] IP acquired: %s\n", WiFi.localIP().toString().c_str());

            // Safe to call mDNS here — TCPIP lock is held by this task
            MDNS.end();
            if (MDNS.begin(MDNS_HOSTNAME)) {
                MDNS.addService("http", "tcp", 80);
                Serial.printf("[MDNS] http://%s.local\n", MDNS_HOSTNAME);
            }

            // serverStarted guard makes this safe to call on every reconnect
            setupServer();
            break;

        case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
            if (wifiWasConnected) {
                Serial.println("[WIFI] Disconnected. Auto-reconnect active...");
                wifiWasConnected = false;
            }
            break;

        default:
            break;
    }
}

// ══════════════════════════════════════════
//  SETUP
// ══════════════════════════════════════════
void setup() {
    Serial.begin(115200);
    delay(500);  // Let serial settle

    Serial.println("\n========================================");
    Serial.println("  ESP32 WiFi Scanner v5");
    Serial.printf("  Chip: %s | CPU: %dMHz\n", ESP.getChipModel(), ESP.getCpuFreqMHz());
    Serial.printf("  Heap: %u bytes free\n", ESP.getFreeHeap());
    Serial.println("========================================");

    initFS();

    // ── Connect to WiFi ──
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    WiFi.onEvent(onWiFiEvent);   // Register BEFORE begin() — catches the initial GOT_IP event
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    Serial.printf("[WIFI] Connecting to %s ", WIFI_SSID);

    int retries = 0;
    while (WiFi.status() != WL_CONNECTED && retries < 40) {
        delay(500);
        Serial.print(".");
        retries++;
    }
    Serial.println();

    if (WiFi.status() == WL_CONNECTED) {
        // ════════════════════════════════
        //  ONLINE MODE
        //  mDNS + server are started by
        //  onWiFiEvent (ARDUINO_EVENT_WIFI_STA_GOT_IP)
        //  which already fired during the
        //  connection loop above.
        // ════════════════════════════════
        Serial.println("========================================");
        Serial.printf("  >>> IP: %s <<<\n", WiFi.localIP().toString().c_str());
        Serial.println("  Enter this in the dashboard.");
        Serial.println("========================================");
        Serial.println("[BOOT] ONLINE — listening for dashboard requests.");

    } else {
        // ════════════════════════════════
        //  OFFLINE MODE — scan + sleep
        // ════════════════════════════════
        Serial.printf("[WIFI] Failed after %d attempts.\n", retries);
        Serial.println("[BOOT] OFFLINE — scanning then deep sleep.");

        // BUG FIX: Scan BEFORE turning off the radio.
        // Previously, WiFi.mode(WIFI_OFF) ran first, killing the radio
        // and causing scanNetworks() to always return -1 (error).
        WiFi.mode(WIFI_STA);  // Ensure radio is in scan-capable STA mode
        performScan();

        // Power down radio AFTER scan to save energy during deep sleep
        WiFi.disconnect(true);
        WiFi.mode(WIFI_OFF);

        uint64_t sleepUS = (uint64_t)SCAN_INTERVAL_MS * 1000ULL;
        Serial.printf("[SLEEP] Deep sleep for %d seconds...\n", SCAN_INTERVAL_MS / 1000);
        Serial.flush();
        esp_sleep_enable_timer_wakeup(sleepUS);
        esp_deep_sleep_start();
    }
}

// ══════════════════════════════════════════
//  LOOP — only runs in ONLINE mode.
//  All WiFi state management is event-driven
//  via onWiFiEvent(). Nothing to do here.
// ══════════════════════════════════════════
void loop() {
    delay(100);  // Yield to FreeRTOS scheduler — prevents WDT reset
}
