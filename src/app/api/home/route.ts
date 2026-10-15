import { NextResponse, type NextRequest } from "next/server";
import { apiSession } from "@/lib/auth";
import { homeParams } from "@/lib/home";
import { fetchHome } from "@/lib/home-server";

// GET /api/home?scope= : every Home part in parallel (home_summary, home_attention, home_recent_activity, today's
// tasks, and Day 6's stock_alerts for Low stock, which answers null until inventory is set up), each one settled on its
// own (design 4.5 and D26: a part may be {ok:false}). Zod-checked (unknown parameters refused); a rep asking for the
// team gets 403, from the database's own scope check (42501). Read-only, private and never cached.
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: NextRequest) {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  const query = homeParams.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!query.success) return NextResponse.json({ error: "invalid" }, { status: 400, headers });
  const home = await fetchHome(session.supabase, query.data.scope ?? "team");
  if (home === "forbidden") return NextResponse.json({ error: "forbidden" }, { status: 403, headers });
  return NextResponse.json(home, { headers });
}
