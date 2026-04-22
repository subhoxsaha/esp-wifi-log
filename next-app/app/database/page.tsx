"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

export default function DatabasePage() {
  const [dbData, setDbData] = useState<any[]>([]);
  const [isWiping, setIsWiping] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Secure Geo-coordinate toggles
  const [isGeoVisible, setIsGeoVisible] = useState(false);
  const [isGeoLoading, setIsGeoLoading] = useState(false);

  useEffect(() => {
    fetchMongoDBData();
  }, []);

  const toggleGeoVisibility = async () => {
    if (isGeoVisible) {
      setIsGeoVisible(false);
      // Hard delete Lat/Lng from local browser memory to ensure absolute security
      setDbData(prev => prev.map(d => {
         const { lat, lng, ...rest } = d;
         return rest;
      }));
    } else {
      setIsGeoLoading(true);
      try {
        const resp = await fetch('/api/db?includeGeo=true');
        const json = await resp.json();
        if (json.success) {
          setDbData(json.data);
          setIsGeoVisible(true);
        }
      } catch (err) {
        console.error("Failed to decrypt coordinates.");
      } finally {
        setIsGeoLoading(false);
      }
    }
  };

  const fetchMongoDBData = async () => {
    setIsLoading(true);
    try {
      const resp = await fetch("/api/db");
      const json = await resp.json();
      if (json.success) {
        setDbData(json.data);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const wipeRemoteDatabase = async () => {
    if (!confirm("Wipe the remote MongoDB Cluster completely? This CANNOT be undone.")) return;
    setIsWiping(true);
    try {
      const resp = await fetch("/api/clear", { method: "DELETE" });
      const json = await resp.json();
      if (json.success) {
        setDbData([]);
      } else {
        alert("Failed to wipe database: " + json.error);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsWiping(false);
    }
  };

  const deleteRow = async (bssid: string) => {
    if (!confirm(`Delete ${bssid} from MongoDB?`)) return;
    try {
      const resp = await fetch(`/api/delete/${encodeURIComponent(bssid)}`, { method: "DELETE" });
      const json = await resp.json();
      if (json.success) {
        setDbData(prev => prev.filter(item => item.bssid !== bssid));
      }
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <>
      <header id="topbar">
        <div className="topbar-left">
          <div className="logo">
            <span className="material-symbols-outlined logo-icon">dataset</span>
            <span className="logo-text">MongoDB Archive</span>
          </div>
        </div>
        <div className="topbar-right">
          <Link href="/">
            <button className="btn-sm">
              <span className="material-symbols-outlined icon-sm">arrow_back</span> Back to Scanner
            </button>
          </Link>
        </div>
      </header>

      <main id="app-layout">
        <section className="split-panel">
          <div className="panel-header" style={{ borderColor: 'var(--accent)'}}>
            <span className="material-symbols-outlined">cloud</span> Cloud Synchronized BSSIDs
          </div>

          <div className="panel-section">
            <div className="action-buttons">
              <button className="btn btn-outline" onClick={fetchMongoDBData} disabled={isLoading}>
                <span className={`material-symbols-outlined btn-icon ${isLoading ? "spinning" : ""}`}>sync</span> 
                {isLoading ? "Fetching..." : "Refresh Database"}
              </button>
              <button className="btn btn-outline" onClick={toggleGeoVisibility} disabled={isGeoLoading}>
                <span className={`material-symbols-outlined btn-icon ${isGeoLoading ? "spinning" : ""}`}>
                   {isGeoLoading ? "lock_open" : isGeoVisible ? "visibility_off" : "visibility"}
                </span> 
                {isGeoLoading ? "Decrypting..." : isGeoVisible ? "Hide Coordinates" : "Show Coordinates"}
              </button>
              <button className="btn btn-danger" onClick={wipeRemoteDatabase} disabled={isWiping}>
                <span className={`material-symbols-outlined btn-icon ${isWiping ? "spinning" : ""}`}>delete</span> 
                {isWiping ? "Wiping..." : "Wipe Remote Collection"}
              </button>
            </div>
            <div style={{ marginTop: '16px', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
               Total Cloud Records: <strong style={{ color: "var(--accent)"}}>{dbData.length}</strong>
            </div>
          </div>

          <div className="panel-section table-container">
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>BSSID (MAC)</th>
                    <th>SSID</th>
                    <th>Signal Strength</th>
                    <th>Channel</th>
                    <th>Lat</th>
                    <th>Lng</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {dbData.length === 0 ? (
                    <tr className="empty-row"><td colSpan={7}>{isLoading ? "Loading MongoDB Data..." : "No data found in Cloud"}</td></tr>
                  ) : dbData.map((d, i) => {
                     const rssiClass = d.rssi >= -50 ? 'rssi-good' : d.rssi >= -70 ? 'rssi-fair' : 'rssi-weak';
                     return (
                      <tr key={i}>
                        <td className="bssid-cell">{d.bssid}</td>
                        <td>{d.ssid || '[Hidden]'}</td>
                        <td><span className={`rssi-tag ${rssiClass}`}>{d.rssi} dBm</span></td>
                        <td>{d.channel}</td>
                        <td style={{ textAlign: 'center' }}>
                          {isGeoLoading ? (
                            <span className="material-symbols-outlined spinning" style={{ fontSize: '1rem', color: 'var(--accent)' }}>sync</span>
                          ) : isGeoVisible ? (
                            <span className="meta-badge">{(d.lat != null && !isNaN(parseFloat(d.lat))) ? parseFloat(d.lat).toFixed(5) : '--'}</span>
                          ) : '--'}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          {isGeoLoading ? (
                            <span className="material-symbols-outlined spinning" style={{ fontSize: '1rem', color: 'var(--accent)' }}>sync</span>
                          ) : isGeoVisible ? (
                            <span className="meta-badge">{(d.lng != null && !isNaN(parseFloat(d.lng))) ? parseFloat(d.lng).toFixed(5) : '--'}</span>
                          ) : '--'}
                        </td>
                        <td>
                           <button className="btn-icon-small" onClick={() => deleteRow(d.bssid)} title="Delete from Database">
                             <span className="material-symbols-outlined" style={{ fontSize: "1rem" }}>delete</span>
                           </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
