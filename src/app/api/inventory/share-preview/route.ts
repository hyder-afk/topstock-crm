import { NextResponse } from "next/server";
import { apiSession } from "@/lib/auth";
import { NO_STORE } from "@/lib/inventory-server";
import { fetchSharePreview } from "@/lib/share-links-server";

// GET /api/inventory/share-preview : what clients see (the client page's whitelist, arriving stock included), for
// "Send stock list as text". Signed-in team only.
export async function GET() {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const preview = await fetchSharePreview(session.supabase);
  if (!preview) return NextResponse.json({ error: "unavailable" }, { status: 502, headers: NO_STORE });
  return NextResponse.json(preview, { headers: NO_STORE });
}
