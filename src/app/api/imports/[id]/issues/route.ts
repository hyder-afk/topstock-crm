import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiSession } from "@/lib/auth";
import { listRateLimited } from "@/lib/rate-limit";
import { importError, type ImportIssue } from "@/lib/import-server";

// GET /api/imports/<id>/issues?after=<row>: up to 1,000 rows the check did not mark plainly ready (rejected, repeated,
// already in the CRM, or ready with a fix), after the given row number. Codes and matches only, never lead values.
// Admin with a fresh two-factor code (the database checks both; a stale code answers 403 {error: "step_up"}).
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const limited = listRateLimited(session.claims.sub);
  if (limited) return limited;
  const { id } = await params;
  const parsed = z
    .object({ id: z.uuid(), after: z.coerce.number().int().min(0).max(50001).default(0) })
    .safeParse({ id, after: request.nextUrl.searchParams.get("after") ?? undefined });
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const { data, error } = await session.supabase.rpc("list_lead_import_issues", {
    p_batch: parsed.data.id,
    p_after_row: parsed.data.after,
    p_limit: 1000,
  });
  if (error) {
    const code = importError(error);
    const status = code === "step_up" || code === "forbidden" ? 403 : code === "invalid" ? 400 : 502;
    return NextResponse.json({ error: code }, { status });
  }
  return NextResponse.json({ issues: (data ?? []) as ImportIssue[] }, { headers: { "Cache-Control": "private, no-store" } });
}
