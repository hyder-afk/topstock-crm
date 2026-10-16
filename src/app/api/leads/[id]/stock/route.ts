import { NextResponse } from "next/server";
import { z } from "zod";
import { apiSession } from "@/lib/auth";
import { listRateLimited } from "@/lib/rate-limit";
import { NO_STORE } from "@/lib/inventory-server";
import { fetchLeadStock } from "@/lib/sales-server";

// GET /api/leads/<id>/stock : the lead's Stock tab (requests with live availability, holds, sales, the deals a sale can
// link to). Read only.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const limited = listRateLimited(session.claims.sub);
  if (limited) return limited;
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return NextResponse.json({ error: "invalid" }, { status: 400, headers: NO_STORE });
  const data = await fetchLeadStock(session.supabase, id.data);
  if (data === "missing") return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  if (!data) return NextResponse.json({ error: "unavailable" }, { status: 502, headers: NO_STORE });
  return NextResponse.json(data, { headers: NO_STORE });
}
