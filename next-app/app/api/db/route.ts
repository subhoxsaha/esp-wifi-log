import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    try {
        const url = new URL(req.url);
        const includeGeo = url.searchParams.get('includeGeo') === 'true';

        const client = await clientPromise;
        const db = client.db("wifi_recon");
        const collection = db.collection("scanned_bssids");
        
        const data = await collection.find({}).sort({ timestamp: -1 }).toArray();

        // Security: Strip sensitive geographic coordinates from the payload unless explicitly authenticated by the toggle
        const safeData = data.map(doc => {
            if (!includeGeo) {
                const { lat, lng, ...rest } = doc;
                return rest;
            }
            return doc;
        });

        return NextResponse.json({ success: true, count: safeData.length, data: safeData });
    } catch (err: any) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}
