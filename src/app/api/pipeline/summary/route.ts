import { NextResponse, type NextRequest } from "next/server";
import { apiSession } from "@/lib/auth";
import { boardParams } from "@/lib/deals";
import { fetchSummary } from "@/lib/deals-server";

// GET /api/pipeline/summary?scope=&owner= : the board's counts and totals (pipeline_summary), for the 30 s refresh. The
// team or a colleague's deals are for managers and admins: 403 for a rep. Private and never cached.
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: NextRequest) {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  const query = boardParams.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!query.success) return NextResponse.json({ error: "invalid" }, { status: 400, headers });
  const summary = await fetchSummary(session.supabase, query.data.scope ?? "team", query.data.owner ?? null);
  if (summary === "invalid") return NextResponse.json({ error: "invalid" }, { status: 400, headers });
  if (summary === "forbidden") return NextResponse.json({ error: "forbidden" }, { status: 403, headers });
  if (!summary) return NextResponse.json({ error: "unavailable" }, { status: 502, headers });
  return NextResponse.json(summary, { headers });
}
