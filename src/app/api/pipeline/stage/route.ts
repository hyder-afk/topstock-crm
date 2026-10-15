import { NextResponse, type NextRequest } from "next/server";
import { apiSession } from "@/lib/auth";
import { stageParams } from "@/lib/deals";
import { fetchStagePage } from "@/lib/deals-server";

// GET /api/pipeline/stage?stage=&scope=&owner=&stalled=1&order=&after_at=&after_id= : one page of a column (keyset on
// the stage clock; won and lost on the close time). The team or a colleague's deals are for managers and admins: 403
// for a rep. A cursor needs both parts: 400 otherwise (the database refuses it too). Private and never cached.
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: NextRequest) {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  const query = stageParams.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!query.success) return NextResponse.json({ error: "invalid" }, { status: 400, headers });
  const q = query.data;
  const page = await fetchStagePage(session.supabase, {
    stage: q.stage,
    scope: q.scope ?? "team",
    owner: q.owner ?? null,
    stalled: q.stalled === "1",
    order: q.order ?? "recent",
    cursor: q.after_at && q.after_id ? { after_at: q.after_at, after_id: q.after_id } : null,
  });
  if (page === "invalid") return NextResponse.json({ error: "invalid" }, { status: 400, headers });
  if (page === "forbidden") return NextResponse.json({ error: "forbidden" }, { status: 403, headers });
  if (!page) return NextResponse.json({ error: "unavailable" }, { status: 502, headers });
  return NextResponse.json(page, { headers });
}
