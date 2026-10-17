import { NextResponse, type NextRequest } from "next/server";
import { apiSession } from "@/lib/auth";
import { noStore } from "@/lib/http";
import { analyticsRateLimited } from "@/lib/rate-limit";
import { DEFAULT_IDLE, parisToday, parseAnalyticsQuery, resolveRange } from "@/lib/analytics/params";
import { fetchAnalytics, fetchAnalyticsRole } from "@/lib/analytics/server";

// GET /api/analytics?range=&from=&to=&rep=&idle= (design docs/evidence/analytics/design.md 2, 3.5 and 3.6): every
// Analytics block for one range and person, each settled on its own ({ok:false} for a block that failed). The query is
// Zod-checked strictly (an unknown or repeated key, a bad value or a custom range out of bounds: 400); the range is
// resolved in Paris time on the server. Signed out or without two-factor: 401. A rep asking for a colleague: 403, from
// the database's own scope check (42501); a person outside the organisation: 400 (P0002). Over 30 reads a minute: 429
// with Retry-After. Read-only, private, never cached; nothing about the request or the database's errors is logged.
export async function GET(request: NextRequest) {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  const limited = analyticsRateLimited(session.claims.sub);
  if (limited) return limited;
  const query = parseAnalyticsQuery(request.nextUrl.searchParams);
  if (!query.success) return NextResponse.json({ error: "invalid" }, { status: 400, headers: noStore });
  const range = resolveRange(query.data, parisToday());
  if (!range) return NextResponse.json({ error: "invalid" }, { status: 400, headers: noStore });
  const role = await fetchAnalyticsRole(session.supabase, session.claims.sub);
  const data = await fetchAnalytics(session.supabase, { range, rep: query.data.rep ?? null, idle: query.data.idle ?? DEFAULT_IDLE }, role);
  if (data === "forbidden") return NextResponse.json({ error: "forbidden" }, { status: 403, headers: noStore });
  if (data === "invalid") return NextResponse.json({ error: "invalid" }, { status: 400, headers: noStore });
  return NextResponse.json(data, { headers: noStore });
}
