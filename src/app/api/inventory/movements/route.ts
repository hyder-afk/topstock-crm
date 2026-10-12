import { NextResponse, type NextRequest } from "next/server";
import { apiSession } from "@/lib/auth";
import { movementParams } from "@/lib/inventory/filters";
import { NO_STORE, fetchMovements } from "@/lib/inventory-server";

// GET /api/inventory/movements?product=&kinds=&user=&from=&to=&before= : one page of the movement log, newest first.
export async function GET(request: NextRequest) {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const raw = Object.fromEntries([...request.nextUrl.searchParams].filter(([, v]) => v !== ""));
  const parsed = movementParams.strict().safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400, headers: NO_STORE });
  const { before, ...filters } = parsed.data;
  const page = await fetchMovements(session.supabase, filters, before ?? null);
  if (page === "invalid") return NextResponse.json({ error: "invalid" }, { status: 400, headers: NO_STORE });
  if (!page) return NextResponse.json({ error: "unavailable" }, { status: 502, headers: NO_STORE });
  return NextResponse.json(page, { headers: NO_STORE });
}
