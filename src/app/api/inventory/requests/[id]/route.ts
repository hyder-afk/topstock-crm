import { NextResponse } from "next/server";
import { z } from "zod";
import { apiSession } from "@/lib/auth";
import { NO_STORE } from "@/lib/inventory-server";
import { fetchRequest } from "@/lib/sales-server";

// GET /api/inventory/requests/<id> : one stock request with its lines and live availability now. Read only.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) return NextResponse.json({ error: "invalid" }, { status: 400, headers: NO_STORE });
  const data = await fetchRequest(session.supabase, id.data);
  if (data === "missing") return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  if (!data) return NextResponse.json({ error: "unavailable" }, { status: 502, headers: NO_STORE });
  return NextResponse.json(data, { headers: NO_STORE });
}
