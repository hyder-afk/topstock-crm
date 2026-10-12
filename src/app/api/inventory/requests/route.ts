import { NextResponse, type NextRequest } from "next/server";
import { apiSession } from "@/lib/auth";
import { NO_STORE } from "@/lib/inventory-server";
import { fetchRequests } from "@/lib/sales-server";
import { requestListParams } from "@/lib/sales/schemas";

// GET /api/inventory/requests?status=open|new|in_progress|done|declined|all&before_created=&before_id= : the requests
// inbox, newest first (the rows the caller may see).
export async function GET(request: NextRequest) {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  const raw = Object.fromEntries([...request.nextUrl.searchParams].filter(([, v]) => v !== ""));
  const parsed = requestListParams.safeParse(raw);
  if (!parsed.success || !!parsed.data.before_created !== !!parsed.data.before_id) {
    return NextResponse.json({ error: "invalid" }, { status: 400, headers: NO_STORE });
  }
  const { before_created, before_id, status } = parsed.data;
  const page = await fetchRequests(session.supabase, status ?? "open", before_created && before_id ? { before_created, before_id } : null);
  if (!page) return NextResponse.json({ error: "unavailable" }, { status: 502, headers: NO_STORE });
  return NextResponse.json(page, { headers: NO_STORE });
}
