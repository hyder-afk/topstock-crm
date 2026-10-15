import { NextResponse } from "next/server";
import { apiSession } from "@/lib/auth";
import { NO_STORE, fetchSummary } from "@/lib/inventory-server";

// GET /api/inventory/summary : the KPI row (pieces in the warehouse, in transit and held; low and sold-out counts).
export async function GET() {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const summary = await fetchSummary(session.supabase);
  if (!summary) return NextResponse.json({ error: "unavailable" }, { status: 502, headers: NO_STORE });
  return NextResponse.json(summary, { headers: NO_STORE });
}
