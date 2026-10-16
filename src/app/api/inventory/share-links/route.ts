import { NextResponse, type NextRequest } from "next/server";
import { apiSession } from "@/lib/auth";
import { listRateLimited } from "@/lib/rate-limit";
import { NO_STORE } from "@/lib/inventory-server";
import { fetchShareLinks } from "@/lib/share-links-server";
import { linkListParams } from "@/lib/share/team";

// GET /api/inventory/share-links?company=<lead> | ?all=1 : the active client links the caller may see (a lead's, or
// every lead's for Settings) and whether sharing is on. Never a token or its hash.
export async function GET(request: NextRequest) {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const limited = listRateLimited(session.claims.sub);
  if (limited) return limited;
  const parsed = linkListParams.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success || (!parsed.data.company && !parsed.data.all)) {
    return NextResponse.json({ error: "invalid" }, { status: 400, headers: NO_STORE });
  }
  const list = await fetchShareLinks(session.supabase, parsed.data.company ?? null);
  if (!list) return NextResponse.json({ error: "unavailable" }, { status: 502, headers: NO_STORE });
  return NextResponse.json(list, { headers: NO_STORE });
}
