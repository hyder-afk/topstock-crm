import { NextResponse } from "next/server";
import { z } from "zod";
import { apiSession } from "@/lib/auth";

// GET /api/leads/<id>: the lead with its owner and contacts (null-safe: 404 when not visible).
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const { data, error } = await session.supabase.rpc("get_lead", { p_id: id.data });
  if (error) return NextResponse.json({ error: "unavailable" }, { status: 502 });
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(data, { headers: { "Cache-Control": "private, no-store" } });
}
