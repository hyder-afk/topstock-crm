import { NextResponse } from "next/server";
import { assertSameOrigin, readJsonCapped } from "@/lib/http";
import { clientIp, createLimiter } from "@/lib/share/rate-limit";
import { requestBodySchema } from "@/lib/share/schema";
import { shareRequest } from "@/lib/share/server";

// POST /api/share/request (design 8.6): a client's request. The same gates as the view with a 16 KB body and 10 per
// 10 minutes per address. A filled honeypot or a send under 2 seconds after the page loaded gets the same "received"
// answer without touching the database. invalid → 400, closed → 403, inactive → 404, slow down / too many open → 429.
const limiter = createLimiter({ windowMs: 600_000, max: 10 });
const headers = { "Cache-Control": "no-store" };
const STATUS: Record<string, number> = { received: 200, invalid: 400, closed: 403, inactive: 404, slow_down: 429, too_many_open: 429 };

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) return NextResponse.json({ status: "forbidden" }, { status: 403, headers });
  const body = await readJsonCapped(request, 16_384);
  if (!body.ok) return NextResponse.json({ status: "invalid" }, { status: body.status, headers });
  const parsed = requestBodySchema.safeParse(body.value);
  if (!parsed.success) return NextResponse.json({ status: "invalid" }, { status: 400, headers });
  if (parsed.data.website !== "" || parsed.data.t < 2000) {
    return NextResponse.json({ status: "received", signature: null }, { status: 200, headers });
  }
  if (!limiter.take(clientIp(request.headers))) return NextResponse.json({ status: "slow_down" }, { status: 429, headers });
  const answer = await shareRequest(parsed.data);
  return NextResponse.json(answer, { status: STATUS[answer.status] ?? 503, headers });
}
