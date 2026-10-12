import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiSession } from "@/lib/auth";
import { stockImportError } from "@/lib/stock-import-server";
import type { StockIssue } from "@/lib/stock-import/types";

// GET /api/stock-imports/<id>/issues?after=<row>: up to 1,000 rows of a stock import that the check did not mark plainly
// good (rejected, repeated, warnings, kept or skipped), after the given row number. Codes only, never values. Admin with
// a fresh two-factor code (the database checks both; a stale code answers 403 {error: "step_up"}).
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const parsed = z
    .object({ id: z.uuid(), after: z.coerce.number().int().min(0).max(5001).default(0) })
    .safeParse({ id, after: request.nextUrl.searchParams.get("after") ?? undefined });
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const { data, error } = await session.supabase.rpc("list_stock_import_issues", {
    p_batch: parsed.data.id,
    p_after_row: parsed.data.after,
    p_limit: 1000,
  });
  if (error) {
    const code = stockImportError(error);
    const status = code === "step_up" || code === "forbidden" ? 403 : code === "invalid" ? 400 : code === "not_found" ? 404 : 502;
    return NextResponse.json({ error: code }, { status });
  }
  return NextResponse.json({ issues: (data ?? []) as StockIssue[] }, { headers: { "Cache-Control": "private, no-store" } });
}
