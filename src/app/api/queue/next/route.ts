import { NextResponse, type NextRequest } from "next/server";
import { apiSession } from "@/lib/auth";
import { invalid } from "@/lib/db-errors";
import { assertSameOrigin, noStore, readJsonBody } from "@/lib/http";
import { RELEASE_MAX_BYTES, nextBody } from "@/lib/queue";
import { claimNext } from "@/lib/queue-server";

// POST /api/queue/next {next} : the next card(s) for the queue (after a Skip: the skipped lead is not in `keep`, so its
// claim goes; or when the reserve ran dry). Moved from server actions with the outcome (design D3's switch rule). Same origin only, JSON only, 32 KB at most, a
// two-factor session, Zod strictObject; codes only, never cached.
export async function POST(request: NextRequest) {
  if (!assertSameOrigin(request.headers)) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: noStore });
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  const body = await readJsonBody(request, RELEASE_MAX_BYTES);
  if (!body.ok) return NextResponse.json({ error: "invalid" }, { status: body.status, headers: noStore });
  const parsed = nextBody.safeParse(body.value);
  if (!parsed.success) return NextResponse.json(invalid("bounds"), { headers: noStore });
  return NextResponse.json(await claimNext(session.supabase, parsed.data.next), { headers: noStore });
}
