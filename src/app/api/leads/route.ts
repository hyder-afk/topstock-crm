import { NextResponse, type NextRequest } from "next/server";
import { apiSession } from "@/lib/auth";
import { cursorParams, parseFilters } from "@/lib/leads";
import { fetchLeadPage } from "@/lib/leads-server";

// GET /api/leads?<filters>&after_value=&after_id= : one page of leads (keyset). The first page also carries the total.
// Filters are Zod-parsed; every value reaches the database as a function parameter, never as SQL or filter text.
export async function GET(request: NextRequest) {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const params = request.nextUrl.searchParams;
  const cursor = params.has("after_id")
    ? cursorParams.safeParse({ after_value: params.get("after_value"), after_id: params.get("after_id") })
    : null;
  if (cursor && !cursor.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const page = await fetchLeadPage(session.supabase, parseFilters(params), cursor?.data ?? null);
  if (!page) return NextResponse.json({ error: "unavailable" }, { status: 502 });
  return NextResponse.json(page, { headers: { "Cache-Control": "private, no-store" } });
}
