"use server";

import { z } from "zod";
import type { ImportResult } from "@/app/(app)/leads/import/actions";
import { requireSession } from "@/lib/auth";
import { isCleanString } from "@/lib/import/text";
import { stockImportError } from "@/lib/stock-import-server";
import { COMMIT_CHUNK, MOVED_POLICIES, STOCK_LIMITS } from "@/lib/stock-import/rules";
import { stockChunkSchema } from "@/lib/stock-import/schema";
import type {
  StockCheckSummary,
  StockCommitStep,
  StockImportBatch,
  StockUndoPreview,
  StockUndoStep,
} from "@/lib/stock-import/types";

// Stock sheet import (Day 6c). Each action: Zod strictObject on its input, the aal2 session, one database function with
// explicit arguments, a short code back. The database decides everything (admin, uploader, fresh code, limits, rules).
const batchId = z.uuid();
const noControl = /^[^\u0000-\u001F\u007F]*$/;

async function call<T>(fn: string, args: Record<string, unknown>): Promise<ImportResult<T>> {
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { ok: false, error: stockImportError(error) };
  return { ok: true, data: data as T };
}

const startInput = z.strictObject({
  filename: z.string().trim().min(1).max(255).regex(noControl).refine((s) => !/[/\\]/.test(s)).refine(isCleanString),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  rowCount: z.int().min(1).max(STOCK_LIMITS.maxDataRows),
  lastRowNo: z.int().min(STOCK_LIMITS.minRowNo + 1).max(STOCK_LIMITS.maxRowNo),
});

export async function startStockImport(input: unknown): Promise<ImportResult<{ batchId: string }>> {
  const parsed = startInput.safeParse(input);
  if (!parsed.success || parsed.data.lastRowNo <= parsed.data.rowCount) return { ok: false, error: "invalid" };
  const result = await call<string>("create_stock_import", {
    p_filename: parsed.data.filename,
    p_file_sha256: parsed.data.sha256,
    p_row_count: parsed.data.rowCount,
    p_last_row_no: parsed.data.lastRowNo,
  });
  return result.ok ? { ok: true, data: { batchId: result.data } } : result;
}

export async function stageStockRows(input: unknown): Promise<ImportResult<{ added: number }>> {
  const parsed = z.strictObject({ batchId, rows: stockChunkSchema }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const result = await call<number>("stage_stock_import_rows", { p_batch: parsed.data.batchId, p_rows: parsed.data.rows });
  return result.ok ? { ok: true, data: { added: result.data } } : result;
}

export async function checkStockImport(input: unknown): Promise<ImportResult<StockCheckSummary>> {
  const parsed = z.strictObject({ batchId, policy: z.enum(MOVED_POLICIES) }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  return call<StockCheckSummary>("validate_stock_import", { p_batch: parsed.data.batchId, p_moved_policy: parsed.data.policy });
}

export async function commitStockStep(input: unknown): Promise<ImportResult<StockCommitStep>> {
  const parsed = z.strictObject({ batchId, size: z.int().min(1).max(COMMIT_CHUNK) }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  return call<StockCommitStep>("commit_stock_import", { p_batch: parsed.data.batchId, p_max_rows: parsed.data.size });
}

export async function previewStockUndo(input: unknown): Promise<ImportResult<StockUndoPreview>> {
  const parsed = z.strictObject({ batchId }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  return call<StockUndoPreview>("preview_stock_import_rollback", { p_batch: parsed.data.batchId });
}

export async function undoStockStep(input: unknown): Promise<ImportResult<StockUndoStep>> {
  const parsed = z.strictObject({ batchId, size: z.int().min(1).max(COMMIT_CHUNK) }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  return call<StockUndoStep>("rollback_stock_import", { p_batch: parsed.data.batchId, p_max_rows: parsed.data.size });
}

export async function discardStockImport(input: unknown): Promise<ImportResult<null>> {
  const parsed = z.strictObject({ batchId }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const result = await call<null>("discard_stock_import", { p_batch: parsed.data.batchId });
  return result.ok ? { ok: true, data: null } : result;
}

export async function listStockImports(input: unknown): Promise<ImportResult<StockImportBatch[]>> {
  const parsed = z
    .strictObject({ id: batchId.optional(), beforeCreated: z.iso.datetime({ offset: true }).optional(), beforeId: batchId.optional() })
    .safeParse(input ?? {});
  if (!parsed.success || (parsed.data.beforeCreated === undefined) !== (parsed.data.beforeId === undefined)) {
    return { ok: false, error: "invalid" };
  }
  return call<StockImportBatch[]>("list_stock_imports", {
    p_limit: 20,
    p_before_created: parsed.data.beforeCreated ?? null,
    p_before_id: parsed.data.beforeId ?? null,
    p_id: parsed.data.id ?? null,
  });
}
