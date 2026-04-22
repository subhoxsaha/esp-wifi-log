"use client";

import { useState, useEffect, useRef } from "react";
import Link from 'next/link';

export default function Home() {
  const [espIp, setEspIp] = useState("");
  const [isConnected, setIsConnected] = useState(false);
  const [status, setStatus] = useState("Disconnected");
  
  const [scanData, setScanData] = useState<any[]>([]);
  const [geolocatedData, setGeolocatedData] = useState<any[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  const [logs, setLogs] = useState<{ time: string; tag: string; msg: string; type: string }[]>([]);
  const [isDebugOpen, setIsDebugOpen] = useState(true);

  // Stats
  const [totalScans, setTotalScans] = useState(0);
  const [searchDots, setSearchDots] = useState('');

  // Animated dots ticker for Searching state
  useEffect(() => {
    if (status !== 'Searching...') { setSearchDots(''); return; }
    const t = setInterval(() => {
      setSearchDots(prev => prev.length >= 3 ? '' : prev + '.');
    }, 400);
    return () => clearInterval(t);
  }, [status]);

  // Backup array data to Session Storage to survive page navigations
  useEffect(() => {
    if (scanData.length > 0) sessionStorage.setItem("wifiRecon_scanData", JSON.stringify(scanData));
  }, [scanData]);

  useEffect(() => {
    if (geolocatedData.length > 0) sessionStorage.setItem("wifiRecon_geoData", JSON.stringify(geolocatedData));
  }, [geolocatedData]);

  // Uptime/Heap
  const [uptime, setUptime] = useState("--");
  const [heap, setHeap] = useState("--");

  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    // Load cached IP and previously scanned session data
    const savedIP = localStorage.getItem("wifiRecon_ip");
    if (savedIP) {
        setEspIp(savedIP);
        // Automatically re-establish hardware connection if coming back from the DB route
        setTimeout(() => connectToESP(savedIP), 300);
    }
    
    try {
        const savedScan = sessionStorage.getItem("wifiRecon_scanData");
        if (savedScan) setScanData(JSON.parse(savedScan));
        
        const savedGeo = sessionStorage.getItem("wifiRecon_geoData");
        if (savedGeo) setGeolocatedData(JSON.parse(savedGeo));
    } catch(e) {}

    addLog("info", "Page loaded (State restored).");

    // CRITICAL: Cleanup polling loops so they don't leak into the DB page memory when unmounted!
    return () => {
        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  const addLog = (tag: "info" | "warn" | "error" | "api" | "scan", msg: string) => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setLogs((prev) => [...prev, { time, tag, msg, type: tag }]);
  };

  const getEspBaseUrl = (ip: string = espIp) => {
    let url = ip.trim();
    if (!url.startsWith("http")) url = `http://${url}`;
    return url.replace(/\/$/, "");
  };

  const connectToESP = async (ipToUse?: string) => {
    const targetIp = typeof ipToUse === 'string' ? ipToUse : espIp;
    if (!targetIp.trim()) {
      addLog("warn", "Enter IP address shown in Serial Monitor.");
      return;
    }
    localStorage.setItem("wifiRecon_ip", targetIp);
    const baseUrl = getEspBaseUrl(targetIp);
    addLog("api", `Targeting ${baseUrl} for Smart Connection...`);
    setStatus("Searching...");
    setIsConnected(false);

    startSmartPolling(targetIp);
  };

  const startSmartPolling = (targetIp: string) => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    
    // Immediate ping so UX is snappy
    pingESP(targetIp);

    // Resilient background daemon that NEVER dies on disconnect
    pollTimerRef.current = setInterval(() => {
       pingESP(targetIp);
    }, 3000);
  };

  const pingESP = async (targetIp: string) => {
      try {
        const resp = await fetch(`${getEspBaseUrl(targetIp)}/status`, { signal: AbortSignal.timeout(2000) });
        if (!resp.ok) throw new Error("Poll HTTP " + resp.status);
        const json = await resp.json();
        
        setIsConnected(true);
        setStatus("Connected");
        setUptime((json.uptime_ms / 1000).toFixed(0) + "s");
        setHeap((json.free_heap / 1024).toFixed(1) + " KB");
        if (json.total_scans !== undefined) setTotalScans(json.total_scans);
      } catch (err) {
        setIsConnected(false);
        setStatus("Searching...");
        setUptime("--");
        setHeap("--");
      }
  };

  const triggerScan = async () => {
    if (!isConnected) return;
    setIsScanning(true);
    addLog("api", `POST /scan-and-fetch`);
    try {
      // Step 1: Tell ESP32 to Scan
      const scanResp = await fetch(`${getEspBaseUrl()}/scan-and-fetch`, { method: "POST", signal: AbortSignal.timeout(20000) });
      if (scanResp.status === 429) {
          addLog("warn", "ESP32 busy — scan already in progress. Wait a few seconds.");
          return;
      }
      if (!scanResp.ok) throw new Error("HTTP " + scanResp.status);
      
      // Step 2: Download raw CSV
      addLog("api", "Scan complete. Fetching CSV data...");
      const dataResp = await fetch(`${getEspBaseUrl()}/data`, { signal: AbortSignal.timeout(10000) });
      if (!dataResp.ok) throw new Error("Data fetch HTTP " + dataResp.status);

      const rawCsv = await dataResp.text();
      const parsed = parseCSV(rawCsv);
      if (parsed) {
         setScanData(parsed);
         await processGeolocation(parsed);
      }
      addLog("scan", `Scan extracted data successfully.`);
    } catch (err: any) {
      addLog("error", `Scan failed: ${err.message}`);
    } finally {
      setIsScanning(false);
    }
  };

  const parseCSV = (csvText: string) => {
    if (!csvText || csvText.trim().length === 0) return [];
    const lines = csvText.trim().split('\n');
    const result = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.length < 5) continue;

        const c1 = line.indexOf(',');
        const c2 = line.indexOf(',', c1 + 1);
        const c3 = line.indexOf(',', c2 + 1);
        const c4 = line.indexOf(',', c3 + 1);
        const c5 = (c4 !== -1) ? line.indexOf(',', c4 + 1) : -1;

        if (c1 === -1 || c2 === -1 || c3 === -1) continue;

        result.push({
            timestamp: parseInt(line.substring(0, c1)),
            bssid: line.substring(c1 + 1, c2).trim(),
            rssi: parseInt(line.substring(c2 + 1, c3)),
            ssid: line.substring(c3 + 1, (c4 !== -1) ? c4 : line.length).trim(),
            channel: parseInt((c4 !== -1 && c5 !== -1) ? line.substring(c4 + 1, c5) : "0"),
            encryption: ((c5 !== -1) ? line.substring(c5 + 1) : "UNKNOWN").trim()
        });
    }
    return result;
  };

  const processGeolocation = async (entries: any[]) => {
    if (!entries || entries.length === 0) return;
    addLog("api", `Determining session geolocation via api.ipapi.com...`);

    let lat = 0;
    let lng = 0;
    let locationStr = 'Unknown';
    let found = false;

    try {
        const resp = await fetch("http://api.ipapi.com/api/check?access_key=d5bc6cc3e10e8c827a205072bdab1717");
        const data = await resp.json();
        
        if (data.latitude && data.longitude) {
            lat = data.latitude;
            lng = data.longitude;
            locationStr = `${data.city || 'Unknown'}, ${data.country_name || 'Unknown'}`;
            found = true;
            addLog("scan", `Session Geolocated: ${locationStr} (${lat}, ${lng})`);
        } else if (data.error) {
            addLog("error", `IPAPI Error: ${data.error.info || 'Unknown API restriction'}`);
        } else {
            addLog("error", `IP Geolocation payload unreadable.`);
        }
    } catch (err) {
        addLog("error", `Failed to reach api.ipapi.com.`);
    }

    if (found) {
        // Apply the resolved Session Macro-Location to all unique BSSIDs captured in this scan
        const uniqueBSSIDs = Array.from(new Set(entries.map(e => e.bssid)));
        const results = uniqueBSSIDs.map(bssid => ({ bssid, lat, lng, locationName: locationStr }));
        setGeolocatedData(results);
    }
  };

  const syncToDB = async () => {
    if (!isConnected || scanData.length === 0) return;
    setIsSyncing(true);
    addLog("api", "POST /api/sync");
    try {
      // Merge scan + geolocation
      const mergedPayload = scanData.map(entry => {
          const geo = geolocatedData.find(g => g.bssid === entry.bssid);
          return { ...entry, lat: geo?.lat, lng: geo?.lng };
      });

      const req = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scanData: mergedPayload }),
      });
      const res = await req.json();
      if (res.success) {
        addLog("info", res.message);
      } else {
        throw new Error(res.error);
      }
    } catch(err: any) {
      addLog("error", `Sync failed: ${err.message}`);
    } finally {
      setIsSyncing(false);
    }
  };

  const clearESP = async () => {
    if (!isConnected || !confirm("Delete ALL stored scan data on ESP32?")) return;
    setIsClearing(true);
    try {
      const resp = await fetch(`${getEspBaseUrl()}/clear`, { method: "POST", signal: AbortSignal.timeout(5000) });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      addLog("info", "ESP32 hardware data cleared.");
      setScanData([]);
    } catch(err: any) {
      addLog("error", `Clear failed: ${err.message}`);
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <>
      <header id="topbar">
        <div className="topbar-left">
          <div className="logo">
            <span className="material-symbols-outlined logo-icon">router</span>
            <span className="logo-text">AeroRecon</span>
          </div>
          <div className={`status-badge ${isConnected ? 'online' : status === 'Searching...' ? 'searching' : 'offline'}`}>
            <span className="status-dot"></span>
            <span>{isConnected ? 'Connected' : status === 'Searching...' ? `Searching${searchDots}` : 'Disconnected'}</span>
          </div>
        </div>
        <div className="topbar-center">
          <div className="connect-bar">
            <label>ESP32 Address:</label>
            <input 
              type="text" 
              value={espIp} 
              onChange={(e) => setEspIp(e.target.value)} 
              onKeyDown={(e) => e.key === 'Enter' && connectToESP()} 
              placeholder="e.g. 192.168.222.187" 
            />
            <button className="btn btn-primary" onClick={() => connectToESP()}>Connect</button>
          </div>
        </div>
        <div className="topbar-right" style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <Link href="/database">
            <button className="btn-sm">
              <span className="material-symbols-outlined icon-sm">dataset</span> Local DB
            </button>
          </Link>
          <span className="meta-badge"><span className="material-symbols-outlined meta-icon">timer</span> {uptime}</span>
          <span className="meta-badge"><span className="material-symbols-outlined meta-icon">memory</span> {heap}</span>
        </div>
      </header>

      <main id="app-layout">
        <section className="split-panel">
          <div className="panel-header">
            <span className="material-symbols-outlined">memory</span> ESP32 Hardware Data
          </div>
          
          <div className="panel-section">
            <div className="action-buttons">
              <button className="btn btn-accent" onClick={triggerScan} disabled={!isConnected || isScanning}>
                <span className={`material-symbols-outlined btn-icon ${isScanning ? "spinning" : ""}`}>{isScanning ? "sync" : "radar"}</span>
                {isScanning ? "Scanning..." : "Scan & Extract"}
              </button>
              <button className="btn btn-outline" onClick={syncToDB} disabled={!isConnected || scanData.length === 0 || isSyncing}>
                <span className={`material-symbols-outlined btn-icon ${isSyncing ? "spinning" : ""}`}>sync</span>
                {isSyncing ? "Syncing..." : "Sync to DB"}
              </button>
              <button className="btn btn-danger" onClick={clearESP} disabled={!isConnected || isClearing}>
                <span className={`material-symbols-outlined btn-icon ${isClearing ? "spinning" : ""}`}>{isClearing ? "sync" : "delete_forever"}</span>
                {isClearing ? "Clearing..." : "Clear ESP32"}
              </button>
            </div>
          </div>

          <div className="panel-section stats-grid">
            <div className="stat-card">
              <div className="stat-val">{scanData.length}</div>
              <div className="stat-label">Total Logs Output</div>
            </div>
            <div className="stat-card">
              <div className="stat-val">{Array.from(new Set(scanData.map(d => d.bssid))).length}</div>
              <div className="stat-label">Unique BSSIDs</div>
            </div>
            <div className="stat-card">
              <div className="stat-val">{totalScans}</div>
              <div className="stat-label">Scans Done</div>
            </div>
          </div>

          <div className="panel-section table-container">
            <h3 className="section-title">ESP32 Raw Results</h3>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>BSSID (MAC)</th>
                    <th>SSID</th>
                    <th>Signal</th>
                    <th>Channel</th>
                    <th>Computed Location</th>
                  </tr>
                </thead>
                <tbody>
                  {scanData.length === 0 ? (
                    <tr className="empty-row"><td colSpan={5}>No data — connect and scan</td></tr>
                  ) : scanData.map((d, i) => {
                     const rssiClass = d.rssi >= -50 ? 'rssi-good' : d.rssi >= -70 ? 'rssi-fair' : 'rssi-weak';
                     const geo = geolocatedData.find(g => g.bssid === d.bssid);
                     return (
                      <tr key={i}>
                        <td className="bssid-cell">{d.bssid}</td>
                        <td>{d.ssid || '[Hidden]'}</td>
                        <td><span className={`rssi-tag ${rssiClass}`}>{d.rssi} dBm</span></td>
                        <td>{d.channel}</td>
                        <td><span className="meta-badge">{geo && geo.locationName ? geo.locationName : 'Computing...'}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </main>

      <footer id="debug-panel" className={isDebugOpen ? '' : 'collapsed'}>
        <div className="debug-header">
          <h4><span className="material-symbols-outlined" style={{ fontSize: '1rem', verticalAlign: 'bottom' }}>terminal</span> Debug Console</h4>
          <div style={{ display: 'flex', gap: '6px' }}>
             <button className="btn-sm" onClick={() => {
                const text = logs.map(l => `[${l.time}] [${l.tag.toUpperCase()}] ${l.msg}`).join('\n');
                const blob = new Blob([text], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'debug_logs.txt';
                a.click();
             }}>
                <span className="material-symbols-outlined icon-sm">download</span> Export
             </button>
             <button className="btn-sm" onClick={() => setLogs([])}>
                <span className="material-symbols-outlined icon-sm">delete</span> Clear
             </button>
             <button className="btn-sm btn-icon-only" onClick={() => setIsDebugOpen(!isDebugOpen)}>
                <span className="material-symbols-outlined icon-sm">{isDebugOpen ? 'expand_more' : 'expand_less'}</span>
             </button>
          </div>
        </div>
        <div className="debug-log">
          {logs.map((log, i) => (
            <div className="log-entry" key={i}>
              <span className="log-time">[{log.time}]</span>
              <span className={`log-tag ${log.type}`}>[{log.tag.toUpperCase()}]</span>
              <span className="log-msg">{log.msg}</span>
            </div>
          ))}
        </div>
      </footer>
    </>
  );
}
