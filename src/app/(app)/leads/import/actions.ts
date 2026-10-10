"use server";

import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { importChunkSchema } from "@/lib/import/schema";
import { isCleanString } from "@/lib/import/text";
import { importError, type ImportBatch, type ImportErrorCode } from "@/lib/import-server";

// Lead import (Day 3b). Each action: Zod on its input, the aal2 session, one database function, a short code back.
// The database decides everything (admin, fresh two-factor code, statuses, limits); these only shape the calls.
export type ImportResult<T> = { ok: true; data: T } | { ok: false; error: ImportErrorCode };

const batchId = z.uuid();
const noControl = /^[^\u0000-\u001F\u007F]*$/;

async function call<T>(fn: string, args: Record<string, unknown>): Promise<ImportResult<T>> {
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { ok: false, error: importError(error) };
  return { ok: true, data: data as T };
}

const startInput = z.strictObject({
  // Shown to every admin (Past imports, the Undo dialog): no controls, slashes, bidi overrides or zero-width characters
  // that could make it read as another file.
  filename: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(noControl)
    .refine((s) => !/[/\\]/.test(s))
    .refine(isCleanString),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  rowCount: z.int().min(1).max(50000),
  lastRowNo: z.int().min(2).max(50001),
  timeZone: z.string().min(1).max(64).regex(/^[A-Za-z0-9_+/-]+$/),
});

export async function startImport(input: unknown): Promise<ImportResult<{ batchId: string }>> {
  const parsed = startInput.safeParse(input);
  if (!parsed.success || parsed.data.lastRowNo <= parsed.data.rowCount) return { ok: false, error: "invalid" };
  const result = await call<string>("create_lead_import", {
    p_filename: parsed.data.filename,
    p_file_sha256: parsed.data.sha256,
    p_row_count: parsed.data.rowCount,
    p_last_row_no: parsed.data.lastRowNo,
    p_timezone: parsed.data.timeZone,
  });
  return result.ok ? { ok: true, data: { batchId: result.data } } : result;
}

export async function stageRows(input: unknown): Promise<ImportResult<{ added: number }>> {
  const parsed = z.strictObject({ batchId, rows: importChunkSchema }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const result = await call<number>("stage_lead_import_rows", { p_batch: parsed.data.batchId, p_rows: parsed.data.rows });
  return result.ok ? { ok: true, data: { added: result.data } } : result;
}

export type CheckSummary = {
  status: string;
  row_count: number;
  ready: number;
  duplicates: number;
  rejected: number;
  issue_counts: Record<string, number>;
};

export async function checkImport(input: unknown): Promise<ImportResult<CheckSummary>> {
  const parsed = z.strictObject({ batchId }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  return call<CheckSummary>("validate_lead_import", { p_batch: parsed.data.batchId });
}

// imported_total: the leads tagged with this import after this call (counted, so right after a pause or a lost answer).
export type CommitStep = {
  status: "committing" | "imported";
  imported_now: number;
  late_duplicates: number;
  remaining: number;
  imported_total: number;
};

export async function commitImportStep(input: unknown): Promise<ImportResult<CommitStep>> {
  const parsed = z.strictObject({ batchId, size: z.int().min(250).max(1000) }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  return call<CommitStep>("commit_lead_import", { p_batch: parsed.data.batchId, p_max_rows: parsed.data.size });
}

export type UndoPreview = { tagged: number; removable: number; kept: number };

export async function previewUndo(input: unknown): Promise<ImportResult<UndoPreview>> {
  const parsed = z.strictObject({ batchId }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  return call<UndoPreview>("preview_lead_import_rollback", { p_batch: parsed.data.batchId });
}

export type UndoStep = { status: "rolling_back" | "rolled_back"; removed_now: number; kept: number | null };

export async function undoImportStep(input: unknown): Promise<ImportResult<UndoStep>> {
  const parsed = z.strictObject({ batchId }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  return call<UndoStep>("rollback_lead_import", { p_batch: parsed.data.batchId, p_max_rows: 2000 });
}

export async function discardImport(input: unknown): Promise<ImportResult<null>> {
  const parsed = z.strictObject({ batchId }).safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const result = await call<null>("discard_lead_import", { p_batch: parsed.data.batchId });
  return result.ok ? { ok: true, data: null } : result;
}

export async function listImports(input: unknown): Promise<ImportResult<ImportBatch[]>> {
  const parsed = z
    .strictObject({ id: batchId.optional(), beforeCreated: z.iso.datetime({ offset: true }).optional(), beforeId: batchId.optional() })
    .safeParse(input ?? {});
  if (!parsed.success || (parsed.data.beforeCreated === undefined) !== (parsed.data.beforeId === undefined)) {
    return { ok: false, error: "invalid" };
  }
  return call<ImportBatch[]>("list_lead_imports", {
    p_limit: 20,
    p_before_created: parsed.data.beforeCreated ?? null,
    p_before_id: parsed.data.beforeId ?? null,
    p_id: parsed.data.id ?? null,
  });
}
