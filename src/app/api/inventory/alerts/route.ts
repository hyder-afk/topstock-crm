import { NextResponse } from "next/server";
import { apiSession } from "@/lib/auth";
import { NO_STORE } from "@/lib/inventory-server";
import { fetchAlerts } from "@/lib/sales-server";

// GET /api/inventory/alerts : the counts for the Requests badge and Home (low, sold out, late, new requests, holds
// ending soon). Read only.
export async function GET() {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const data = await fetchAlerts(session.supabase);
  if (!data) return NextResponse.json({ error: "unavailable" }, { status: 502, headers: NO_STORE });
  return NextResponse.json(data, { headers: NO_STORE });
}
