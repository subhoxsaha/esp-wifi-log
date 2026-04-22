import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

export async function DELETE() {
    try {
        const client = await clientPromise;
        const db = client.db("wifi_recon");
        const collection = db.collection("scanned_bssids");
        
        await collection.deleteMany({});
        return NextResponse.json({ success: true, message: "Database wiped completely." });
    } catch (err: any) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 });
    }
}
