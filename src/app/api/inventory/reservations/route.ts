import { NextResponse, type NextRequest } from "next/server";
import { apiSession } from "@/lib/auth";
import { reservationParams } from "@/lib/inventory/filters";
import { NO_STORE, fetchReservations } from "@/lib/inventory-server";

// GET /api/inventory/reservations?company=&product=&status=&before_created=&before_id= : one page of holds, newest first.
export async function GET(request: NextRequest) {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const raw = Object.fromEntries([...request.nextUrl.searchParams].filter(([, v]) => v !== ""));
  const parsed = reservationParams.strict().safeParse(raw);
  if (!parsed.success || !!parsed.data.before_created !== !!parsed.data.before_id) {
    return NextResponse.json({ error: "invalid" }, { status: 400, headers: NO_STORE });
  }
  const { before_created, before_id, ...filters } = parsed.data;
  const cursor = before_created && before_id ? { before_created, before_id } : null;
  const page = await fetchReservations(session.supabase, filters, cursor);
  if (page === "invalid") return NextResponse.json({ error: "invalid" }, { status: 400, headers: NO_STORE });
  if (!page) return NextResponse.json({ error: "unavailable" }, { status: 502, headers: NO_STORE });
  return NextResponse.json(page, { headers: NO_STORE });
}
