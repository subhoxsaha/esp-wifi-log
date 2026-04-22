import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

export async function POST(request: Request) {
    try {
        const { scanData } = await request.json();
        
        if (!Array.isArray(scanData)) {
            return NextResponse.json({ success: false, error: "Invalid data payload" }, { status: 400 });
        }

        if (scanData.length === 0) {
            return NextResponse.json({ success: true, added: 0, updated: 0, message: "Empty array provided" });
        }

        const client = await clientPromise;
        const db = client.db("wifi_recon");
        const collection = db.collection("scanned_bssids");

        // Deduplicate in-memory by BSSID robustly
        const uniqueScanDataMap = new Map();
        for (const doc of scanData) {
            if (doc && doc.bssid) {
                uniqueScanDataMap.set(String(doc.bssid).trim(), doc);
            }
        }
        const deduplicatedScanData = Array.from(uniqueScanDataMap.values());

        if (deduplicatedScanData.length === 0) {
            return NextResponse.json({ success: true, added: 0, updated: 0, message: "Valid parsed array empty" });
        }

        // Build BulkWrite operations with extremely strict type boundaries safely mapped
        const bulkOps = deduplicatedScanData.map((doc: any) => {
            const updateFields: any = {
                bssid: String(doc.bssid),
                ssid: doc.ssid !== undefined ? String(doc.ssid) : "Unknown",
                rssi: Number(doc.rssi) || -100,
                channel: Number(doc.channel) || 0,
                encryption: doc.encryption ? String(doc.encryption) : "NONE",
                // JSON converts NaN to null across network boundaries, so we strictly check and fallback
                timestamp: doc.timestamp ? Number(doc.timestamp) : Date.now()
            };

            // Only append geolocation info if it actually exists in this batch and is safely typed
            if (doc.lat != null && !isNaN(Number(doc.lat))) updateFields.lat = Number(doc.lat);
            if (doc.lng != null && !isNaN(Number(doc.lng))) updateFields.lng = Number(doc.lng);

            return {
                updateOne: {
                    filter: { bssid: String(doc.bssid) },
                    update: { $set: updateFields },
                    upsert: true
                }
            };
        });

        const result = await collection.bulkWrite(bulkOps, { ordered: false });
        
        return NextResponse.json({ 
            success: true, 
            upsertedCount: result.upsertedCount, 
            modifiedCount: result.modifiedCount,
            matchedCount: result.matchedCount,
            message: `Synced! ${result.upsertedCount} new, ${result.modifiedCount} updated.`
        });
    } catch (err: any) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}
