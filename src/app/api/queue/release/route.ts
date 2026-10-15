import { NextResponse, type NextRequest } from "next/server";
import { apiSession } from "@/lib/auth";
import { assertSameOrigin, noStore, readJsonBody } from "@/lib/http";
import { RELEASE_MAX_BYTES, releaseBody } from "@/lib/queue";

// POST /api/queue/release {ids?: uuid[] (at most 3)} : lets go of the caller's queue claims when the queue tab is closed
// or hidden for good (pagehide, sent with fetch keepalive, so it outlives the page). A route handler, not a server
// action, because a page that is going away cannot wait for an action's answer. Same origin only (Origin, or
// Sec-Fetch-Site when no Origin is sent), JSON only, 32 KB at most, a two-factor session; answers codes only and is
// never cached. Releasing only ever removes the caller's own claims (release_claims).
export async function POST(request: NextRequest) {
  if (!assertSameOrigin(request.headers)) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: noStore });
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  const body = await readJsonBody(request, RELEASE_MAX_BYTES);
  if (!body.ok) return NextResponse.json({ error: "invalid" }, { status: body.status, headers: noStore });
  const parsed = releaseBody.safeParse(body.value);
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400, headers: noStore });
  const { data, error } = await session.supabase.rpc("release_claims", { p_ids: parsed.data.ids ?? null });
  if (error) return NextResponse.json({ error: "unavailable" }, { status: 502, headers: noStore });
  return NextResponse.json({ released: Number(data ?? 0) }, { headers: noStore });
}
