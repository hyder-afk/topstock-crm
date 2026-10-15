import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { timelineParams } from "@/lib/activities";
import { apiSession } from "@/lib/auth";
import { listRateLimited } from "@/lib/rate-limit";
import { fetchTimelinePage } from "@/lib/leads-server";

// GET /api/leads/<id>/activities?types=&before_at=&before_id= : one page of the lead's timeline (keyset, newest first).
// Zod-checked (unknown parameters refused); every value reaches the database as a function argument. A cursor needs
// both parts: 400 otherwise (the database refuses it too). Private and never cached.
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  const limited = listRateLimited(session.claims.sub);
  if (limited) return limited;
  const id = z.uuid().safeParse((await params).id);
  const query = timelineParams.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!id.success || !query.success || (query.data.before_at === undefined) !== (query.data.before_id === undefined)) {
    return NextResponse.json({ error: "invalid" }, { status: 400, headers });
  }
  const { types, before_at, before_id } = query.data;
  const cursor = before_at && before_id ? { before_at, before_id } : null;
  const page = await fetchTimelinePage(session.supabase, id.data, types ?? null, cursor);
  if (page === "invalid") return NextResponse.json({ error: "invalid" }, { status: 400, headers });
  if (!page) return NextResponse.json({ error: "unavailable" }, { status: 502, headers });
  return NextResponse.json(page, { headers });
}
