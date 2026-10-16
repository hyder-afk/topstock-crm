import { NextResponse, type NextRequest } from "next/server";
import { apiSession } from "@/lib/auth";
import { listRateLimited } from "@/lib/rate-limit";
import { NO_STORE } from "@/lib/inventory-server";
import { fetchSales } from "@/lib/sales-server";
import { saleListParams } from "@/lib/sales/schemas";

// GET /api/inventory/sales?company=&fulfilment=&before_created=&before_id= : one page of sales, newest first (the rows
// the caller may see; totals computed in the database).
export async function GET(request: NextRequest) {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const limited = listRateLimited(session.claims.sub);
  if (limited) return limited;
  const raw = Object.fromEntries([...request.nextUrl.searchParams].filter(([, v]) => v !== ""));
  const parsed = saleListParams.safeParse(raw);
  if (!parsed.success || !!parsed.data.before_created !== !!parsed.data.before_id) {
    return NextResponse.json({ error: "invalid" }, { status: 400, headers: NO_STORE });
  }
  const { before_created, before_id, ...filters } = parsed.data;
  const page = await fetchSales(session.supabase, filters, before_created && before_id ? { before_created, before_id } : null);
  if (!page) return NextResponse.json({ error: "unavailable" }, { status: 502, headers: NO_STORE });
  return NextResponse.json(page, { headers: NO_STORE });
}
