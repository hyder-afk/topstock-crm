import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiSession } from "@/lib/auth";
import { listRateLimited } from "@/lib/rate-limit";
import { fetchFilesPage } from "@/lib/files/files-server";

// GET /api/leads/<id>/files?before_at=&before_id= : a page of the lead's files (list_lead_files; both cursor parts or
// none, else 400) and, on the first page, the team's usage for managers and admins. Private and never cached.
const headers = { "Cache-Control": "private, no-store" };
const cursor = z.strictObject({ before_at: z.iso.datetime({ offset: true }).optional(), before_id: z.uuid().optional() });

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  const limited = listRateLimited(session.claims.sub);
  if (limited) return limited;
  const id = z.uuid().safeParse((await params).id);
  const q = cursor.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!id.success || !q.success || (q.data.before_at === undefined) !== (q.data.before_id === undefined)) {
    return NextResponse.json({ error: "invalid" }, { status: 400, headers });
  }
  const before = q.data.before_at && q.data.before_id ? { at: q.data.before_at, id: q.data.before_id } : null;
  const page = await fetchFilesPage(session.supabase, id.data, before);
  if (!page) return NextResponse.json({ error: "unavailable" }, { status: 502, headers });
  return NextResponse.json(page, { headers });
}
