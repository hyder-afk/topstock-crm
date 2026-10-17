import { NextResponse, type NextRequest } from "next/server";
import { apiSession } from "@/lib/auth";
import { listRateLimited } from "@/lib/rate-limit";
import { boardParams } from "@/lib/deals";
import { fetchBoard } from "@/lib/deals-server";

// GET /api/pipeline/board?scope=&owner=&order= : the board's first paint (pipeline_board: summaries plus 50 cards per column).
// A rep asking for the team silently gets their own deals (design D21). Zod-checked (unknown parameters refused); every
// value reaches the database as a function argument. Read-only, private and never cached.
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: NextRequest) {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  const limited = listRateLimited(session.claims.sub);
  if (limited) return limited;
  const query = boardParams.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!query.success) return NextResponse.json({ error: "invalid" }, { status: 400, headers });
  const board = await fetchBoard(session.supabase, query.data.scope ?? "team", query.data.owner ?? null, query.data.order ?? "recent");
  if (board === "invalid") return NextResponse.json({ error: "invalid" }, { status: 400, headers });
  if (board === "forbidden") return NextResponse.json({ error: "forbidden" }, { status: 403, headers });
  if (!board) return NextResponse.json({ error: "unavailable" }, { status: 502, headers });
  return NextResponse.json(board, { headers });
}
