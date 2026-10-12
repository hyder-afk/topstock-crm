import { NextResponse } from "next/server";
import { assertSameOrigin, readJsonCapped } from "@/lib/http";
import { snapshotToWire } from "@/lib/share/map";
import { clientIp, createLimiter } from "@/lib/share/rate-limit";
import { viewBodySchema } from "@/lib/share/schema";
import { shareView } from "@/lib/share/server";

// POST /api/share/view (design 8.6): the client page's stock list. JSON only, at most 2 KB, same origin, Zod strict,
// 60 a minute per address on this instance, then one RPC as anon. ok → 200, inactive → 404, slow down → 429, anything
// else → 503. Never cached; nothing logged.
const limiter = createLimiter({ windowMs: 60_000, max: 60 });
const headers = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return NextResponse.json({ status: "forbidden" }, { status: 403, headers });
  const body = await readJsonCapped(request, 2048);
  if (!body.ok) return NextResponse.json({ status: "invalid" }, { status: body.status, headers });
  const parsed = viewBodySchema.safeParse(body.value);
  if (!parsed.success) return NextResponse.json({ status: "inactive" }, { status: 404, headers });
  if (!limiter.take(clientIp(request.headers))) return NextResponse.json({ status: "slow_down" }, { status: 429, headers });
  const answer = await shareView(parsed.data.token, parsed.data.knownVersion);
  const status = answer.status === "ok" ? 200 : answer.status === "inactive" ? 404 : answer.status === "slow_down" ? 429 : 503;
  // A full list travels as positional arrays (checked fields only, about 50 bytes an item); the page maps them back.
  return NextResponse.json("items" in answer ? snapshotToWire(answer) : answer, { status, headers });
}
