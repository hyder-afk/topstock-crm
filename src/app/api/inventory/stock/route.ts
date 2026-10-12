import { NextResponse, type NextRequest } from "next/server";
import { apiSession } from "@/lib/auth";
import { parseStockFilters, stockCursorParams } from "@/lib/inventory/filters";
import { NO_STORE, fetchStockPage } from "@/lib/inventory-server";

// GET /api/inventory/stock?<filters>&after_value=&after_id= : one keyset page of the stock table (the first page also
// carries the total). Read-only; filters are Zod-parsed and reach the database as function arguments only.
export async function GET(request: NextRequest) {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const params = request.nextUrl.searchParams;
  const cursor = params.has("after_id")
    ? stockCursorParams.safeParse({ after_value: params.get("after_value"), after_id: params.get("after_id") })
    : null;
  if (cursor && !cursor.success) return NextResponse.json({ error: "invalid" }, { status: 400, headers: NO_STORE });
  const page = await fetchStockPage(session.supabase, parseStockFilters(params), cursor?.data ?? null);
  if (page === "invalid") return NextResponse.json({ error: "invalid" }, { status: 400, headers: NO_STORE });
  if (!page) return NextResponse.json({ error: "unavailable" }, { status: 502, headers: NO_STORE });
  return NextResponse.json(page, { headers: NO_STORE });
}
