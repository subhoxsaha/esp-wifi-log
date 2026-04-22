# ESP32 WiFi Recon Scanner & Dashboard

A comprehensive, low-power IoT project that pairs an autonomous ESP32 WiFi scanner with a standalone, dual-page web dashboard. 

The ESP32 autonomously sweeps the area for WiFi networks utilizing deep sleep, hardware-level deduplicates them using an **RTC Ring Buffer** to prevent flash wear, and logs everything to persistent LittleFS storage. The browser dashboard connects to the ESP32 to extract this data, geolocates the access points using their BSSID, and syncs them directly into a persistent **MongoDB Atlas Cloud Database**.

---

## 🏗️ Architecture

The system is decoupled into two specifically optimized components:

### 1. ESP32 Autonomous Node (`ESP32_WiFi_Scanner.ino`)
The hardware acts as a low-power headless logger and API Server.
- **File System**: LittleFS (`/wifi_data.csv`)
- **Memory Management**: Uses a custom `RTC_DATA_ATTR` Ring Buffer. Upon a hard power-loss, the ring buffer automatically "rehydrates" itself by parsing the CSV backwards to prevent duplicate logging and massive flash degradation.
- **Thread Safety**: Employs an event-driven `WiFi.onEvent()` system to correctly inherit the internal `TCPIP` lock, completely preventing `tcp_alloc` unhandled panic crashes during mDNS startup.
- **Dual Flow**:
  - **Online Mode**: Stays awake and acts as an HTTP server responding to dashboard requests.
  - **Offline Mode**: Operates completely autonomously. Powers up radio $\rightarrow$ scans $\rightarrow$ powers down radio $\rightarrow$ stores to filesystem $\rightarrow$ enters microamp deep-sleep.

### 2. Full-Stack Dashboard (`/next-app`)
The user interface is a modern, responsive web application built with **Next.js (App Router)** and **React**.
- **Scanner View (`app/page.tsx`)**: Real-time interface to trigger hardware scans, read the direct ESP32 buffer, and monitor device health metrics (Free Heap, Target Uptime).
- **MongoDB Archive (`app/database/page.tsx`)**: A discrete, securely-routed page managing the persistent MongoDB cloud sync via Next.js API Routes. Enables filtering and exporting potentially tens of thousands of logs natively, meaning you don't have to keep the ESP32 plugged in to view your historical recon data.
- **Geolocation Caching**: Reverse-geolocates hardware BSSIDs to physical coordinates utilizing algorithms to instantly render without thrashing rate-limited APIs.

---

## ⚡ Quick Start

### 1. Flashing the ESP32
1. Open `ESP32_WiFi_Scanner/ESP32_WiFi_Scanner.ino` in the Arduino IDE.
2. Install the required libraries via Library Manager:
   - `ESPAsyncWebServer`
   - `ArduinoJson`
3. Verify your partition scheme allocates space for **LittleFS** (e.g., standard 1.2MB APP / 1.5MB SPIFFS/LittleFS).
4. Provide your home WiFi settings in the `#define WIFI_SSID` constants.
5. Upload the code to your ESP32.

### 2. Launching the Next.js Dashboard
The dashboard has been migrated to a secure Next.js architecture to strictly handle the MongoDB database connection.
1. Navigate to the `next-app/` folder on your computer.
2. Inside `.env.local` ensure your `MONGO_URI` is correctly populated.
3. Run `npm install mongodb` inside the folder.
4. Run `npm run dev` to boot the application.
5. Open your browser to `http://localhost:3000`.
6. Look at the top bar and enter your ESP32's IP address (You can grab this directly from your Arduino Serial Console once it boots).
7. Click **Connect**. Use the **Scan & Extract** button on the Scanner page, then swap to the **Local DB** page to securely sync your physical data!

---

## 🛠️ API Reference (ESP32)

If you wish to build custom tools against the ESP32 hardware node, the following endpoints are aggressively CORS-unlocked:

| Endpoint | Method | Expected Return | Description |
| :--- | :--- | :--- | :--- |
| `/status` | GET | JSON | Returns active device uptime, free heap, total scans run, and connection state. |
| `/scan-and-fetch` | POST | JSON | Powers up the radio, executes a synchronized network sweep, updates the Ring Buffer deduplicator, and writes to flash. |
| `/data` | GET | text/csv | Streams the raw LittleFS CSV database file directly to the client. |
| `/clear` | POST | JSON | Formats the LittleFS partition and zeroes out the RTC tracking arrays. |

---

## 🗺️ How Geolocation Works

**No GPS hardware is used in this project.**

1. The ESP32 captures the **BSSID** (the physical MAC address of a router) mapping the physical space around it.
2. The frontend sends these specific extracted BSSIDs to algorithmic geolocation databases like the Mylnikov API / Google Maps Geolocation API.
3. The database parses crowdsourced telemetry to return approximate Latitude/Longitude coordinates for the specified routers.
4. Using an algorithm called **Weighted Centroid Trilateration**, the frontend combines the coordinates of all found routers, heavily weighting those with the strongest signal (closest to the ESP32).
5. The result is an incredibly accurate, real-world positioning marker for the ESP32 hardware itself—achieved using nothing but a standard WiFi antenna.
