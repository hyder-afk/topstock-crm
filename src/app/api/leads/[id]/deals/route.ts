import { NextResponse } from "next/server";
import { z } from "zod";
import { apiSession } from "@/lib/auth";
import { listRateLimited } from "@/lib/rate-limit";
import { fetchLeadDeals } from "@/lib/deals-server";

// GET /api/leads/<id>/deals : the lead's deals the caller sees (list_lead_deals: open first, then closed), for the lead
// page's Deals tab and the composer's deal chip. Private and never cached.
const headers = { "Cache-Control": "private, no-store" };

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  const limited = listRateLimited(session.claims.sub);
  if (limited) return limited;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return NextResponse.json({ error: "invalid" }, { status: 400, headers });
  const deals = await fetchLeadDeals(session.supabase, id.data);
  if (deals === "invalid") return NextResponse.json({ error: "invalid" }, { status: 400, headers });
  if (deals === "forbidden") return NextResponse.json({ error: "forbidden" }, { status: 403, headers });
  if (!deals) return NextResponse.json({ error: "unavailable" }, { status: 502, headers });
  return NextResponse.json(deals, { headers });
}
