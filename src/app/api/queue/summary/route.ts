import { NextResponse, type NextRequest } from "next/server";
import { apiSession } from "@/lib/auth";
import { noStore } from "@/lib/http";
import { summaryParams } from "@/lib/queue";

// GET /api/queue/summary?scope=&skip_lunch= : the queue's start-screen counts (queue_summary) when the scope or the
// lunch switch changes. Read only (no claim is made on GET or render, design 4.2). Zod-checked; a scope reserved to
// managers and admins answers 403. Private and never cached.
export async function GET(request: NextRequest) {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  const query = summaryParams.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!query.success) return NextResponse.json({ error: "invalid" }, { status: 400, headers: noStore });
  const { data, error } = await session.supabase.rpc("queue_summary", {
    p_scope: query.data.scope ?? "mine",
    p_skip_lunch: query.data.skip_lunch === "1",
  });
  if (error?.code === "42501") return NextResponse.json({ error: "forbidden" }, { status: 403, headers: noStore });
  if (error) return NextResponse.json({ error: "unavailable" }, { status: 502, headers: noStore });
  return NextResponse.json(data, { headers: noStore });
}
