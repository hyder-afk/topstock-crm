import { NextResponse, type NextRequest } from "next/server";
import { apiSession } from "@/lib/auth";
import { invalid } from "@/lib/db-errors";
import { assertSameOrigin, noStore, readJsonBody } from "@/lib/http";
import { OUTCOME_MAX_BYTES, queueOutcomeInput } from "@/lib/queue";
import { logOutcome } from "@/lib/queue-server";

// POST /api/queue/outcome {log, next} : a call outcome from the queue, then the next card, in one request (Day 4 design
// D3). The design's switch rule moved this from a server action to a route handler: the measured p95 from key to
// "outcome saved" was over 400 ms (docs/evidence/day4c/README.md). Same checks as a server action and more: same origin
// only (Origin, or Sec-Fetch-Site), JSON only, 64 KB at most, a two-factor session, Zod strictObject; the answer is
// {ok, data} or {ok: false, error, hint} with codes only, never cached. HTTP errors only for a request that is not the
// app's own (403, 401, 413, 415, 400).
export async function POST(request: NextRequest) {
  if (!assertSameOrigin(request.headers)) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: noStore });
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  const body = await readJsonBody(request, OUTCOME_MAX_BYTES);
  if (!body.ok) return NextResponse.json({ error: "invalid" }, { status: body.status, headers: noStore });
  const parsed = queueOutcomeInput.safeParse(body.value);
  if (!parsed.success) return NextResponse.json(invalid("outcome"), { headers: noStore });
  return NextResponse.json(await logOutcome(session.supabase, parsed.data), { headers: noStore });
}
