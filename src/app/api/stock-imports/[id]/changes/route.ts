import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiSession } from "@/lib/auth";
import { stockImportError } from "@/lib/stock-import-server";
import type { StockChange } from "@/lib/stock-import/types";

// GET /api/stock-imports/<id>/changes?after=<n>: up to 200 lines of the change table (design 7.9), one per product,
// after the given row number (before the import) or product number (after it). Admin with a fresh two-factor code.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await apiSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const parsed = z
    .object({ id: z.uuid(), after: z.coerce.number().int().min(0).max(2_000_000_000).default(0) })
    .safeParse({ id, after: request.nextUrl.searchParams.get("after") ?? undefined });
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const { data, error } = await session.supabase.rpc("list_stock_import_changes", {
    p_batch: parsed.data.id,
    p_after_row: parsed.data.after,
    p_limit: 200,
  });
  if (error) {
    const code = stockImportError(error);
    const status = code === "step_up" || code === "forbidden" ? 403 : code === "invalid" ? 400 : code === "not_found" ? 404 : 502;
    return NextResponse.json({ error: code }, { status });
  }
  return NextResponse.json({ changes: (data ?? []) as StockChange[] }, { headers: { "Cache-Control": "private, no-store" } });
}
