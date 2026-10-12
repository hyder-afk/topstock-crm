import { NextResponse } from "next/server";
import { z } from "zod";
import { apiSession } from "@/lib/auth";
import { fetchDeal } from "@/lib/deals-server";

// GET /api/deals/<id> : one deal for the deal sheet (get_deal): its card, lead, contact, owner, rights, Undo, history and
// the last entries (never their text). 404 when missing or not visible (the same answer for both). Never cached.
const headers = { "Cache-Control": "private, no-store" };

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return NextResponse.json({ error: "invalid" }, { status: 400, headers });
  const deal = await fetchDeal(session.supabase, id.data);
  if (deal === "error") return NextResponse.json({ error: "unavailable" }, { status: 502, headers });
  if (!deal) return NextResponse.json({ error: "not_found" }, { status: 404, headers });
  return NextResponse.json(deal, { headers });
}
