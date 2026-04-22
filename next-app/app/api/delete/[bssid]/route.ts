import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ bssid: string }> | { bssid: string } }
) {
    try {
        const resolvedParams = await Promise.resolve(params);
        const { bssid } = resolvedParams;
        const client = await clientPromise;
        const db = client.db("wifi_recon");
        const collection = db.collection("scanned_bssids");
        
        const result = await collection.deleteOne({ bssid: decodeURIComponent(bssid) });
        return NextResponse.json({ success: true, deletedCount: result.deletedCount });
    } catch (err: any) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}
