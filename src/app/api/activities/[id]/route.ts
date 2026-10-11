import { NextResponse } from "next/server";
import { z } from "zod";
import { apiSession } from "@/lib/auth";

// GET /api/activities/<id> : one timeline entry with its whole text ("Show more"); 404 when missing or not visible.
const headers = { "Cache-Control": "private, no-store" };

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return NextResponse.json({ error: "invalid" }, { status: 400, headers });
  const { data, error } = await session.supabase.rpc("get_activity", { p_id: id.data });
  if (error) return NextResponse.json({ error: "unavailable" }, { status: 502, headers });
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404, headers });
  return NextResponse.json(data, { headers });
}
