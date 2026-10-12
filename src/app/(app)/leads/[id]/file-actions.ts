"use server";

import { requireSession } from "@/lib/auth";
import { invalid, toActionFailure, type ActionResult } from "@/lib/db-errors";
import { cleanFileName } from "@/lib/files/name";
import { checkStoredFile } from "@/lib/files/stored";
import { afterUploadCheck } from "@/lib/files/stored-bytes";
import { BUCKET, beginUploadInput, fileIdInput, type FileMime, type LeadFile } from "@/lib/files/types";

// The Files tab's writes (Day 4 design 4.3 and 5.7). Each action: Zod strictObject first, then requireSession()
// (two-factor sessions only), then the database functions with their arguments named one by one. Storage calls run
// with the person's own session, so the bucket's policies decide as for a direct call. Answers carry codes only.

type Supabase = Awaited<ReturnType<typeof requireSession>>["supabase"];

/** Removes the bytes of files already marked "deleting", then their rows. Quiet: what fails waits for the next try. */
async function clearDeleting(supabase: Supabase, items: { id?: string; path: string }[]) {
  if (items.length === 0) return;
  const { error } = await supabase.storage.from(BUCKET).remove(items.map((i) => i.path));
  if (error) return;
  for (const item of items) {
    if (item.id) await supabase.rpc("finish_file_delete", { p_id: item.id });
  }
}

/** Starts an upload: the caller's abandoned uploads (over 15 minutes) cleaned up first, then the name cleaned (no
 *  invisible or bidi characters, at most 180, the type's extension) and the row made pending. Returns where to send the
 *  bytes. The clean-up is its own call, before the new row: a refusal of the new row (space full, limits) cannot undo
 *  it, and the abandoned bytes no longer count when the space is judged (verifier 4d round 2 finding 4). */
export async function beginUpload(input: unknown): Promise<ActionResult<{ id: string; path: string; name: string }>> {
  const parsed = beginUploadInput.safeParse(input);
  if (!parsed.success) return invalid("file_type");
  const v = parsed.data;
  const name = cleanFileName(v.name, v.mime);
  const { supabase } = await requireSession();
  const stale = await supabase.rpc("take_stale_uploads");
  // Quiet: rows it marked "deleting" are listed with Retry if their bytes cannot be removed now.
  if (!stale.error && Array.isArray(stale.data)) await clearDeleting(supabase, stale.data as { id: string; path: string }[]);
  const { data, error } = await supabase.rpc("begin_file_upload", { p_company: v.leadId, p_name: name, p_mime: v.mime, p_size: v.size });
  if (error) return toActionFailure(error);
  const r = data as { id: string; path: string };
  return { ok: true, data: { id: r.id, path: r.path, name } };
}

/** Finishes an upload: the stored bytes are read back and checked (sniffFile); a file that is not what it claims is
 *  removed (type_mismatch); otherwise the database marks it ready once the stored size and type match the declared.
 *  When the bytes cannot be read back (Storage error, timeout, no link) nothing is deleted: the answer is
 *  "unavailable" and the row stays pending until Cancel or the 15-minute cleanup removes it. */
export async function finishUpload(input: unknown): Promise<ActionResult<Pick<LeadFile, "id" | "name" | "mime" | "size" | "created_at">>> {
  const parsed = fileIdInput.safeParse(input);
  if (!parsed.success) return invalid();
  const { supabase } = await requireSession();
  const pending = await supabase.rpc("get_pending_upload", { p_id: parsed.data.id });
  if (pending.error) return toActionFailure(pending.error);
  const p = pending.data as { path: string; mime: FileMime; size: number };
  const stored = await checkStoredFile(supabase, p.path, p.mime, p.size);
  const next = afterUploadCheck(stored);
  if (next === "keep_pending") return { ok: false, error: "unavailable" };
  if (next === "discard") {
    await discard(supabase, parsed.data.id);
    return { ok: false, error: "type_mismatch" };
  }
  const { data, error } = await supabase.rpc("finish_file_upload", { p_id: parsed.data.id });
  if (error) {
    const failure = toActionFailure(error);
    if (failure.error === "type_mismatch") await discard(supabase, parsed.data.id);
    return failure;
  }
  return { ok: true, data: data as Pick<LeadFile, "id" | "name" | "mime" | "size" | "created_at"> };
}

async function discard(supabase: Supabase, id: string) {
  const { data: path, error } = await supabase.rpc("abort_file_upload", { p_id: id });
  if (!error && typeof path === "string") await clearDeleting(supabase, [{ id, path }]);
}

/** Cancels one's own upload (pending -> deleting, bytes removed, row removed). */
export async function abortUpload(input: unknown): Promise<ActionResult<null>> {
  const parsed = fileIdInput.safeParse(input);
  if (!parsed.success) return invalid();
  const { supabase } = await requireSession();
  const { data: path, error } = await supabase.rpc("abort_file_upload", { p_id: parsed.data.id });
  if (error) return toActionFailure(error);
  await clearDeleting(supabase, [{ id: parsed.data.id, path: path as string }]);
  return { ok: true, data: null };
}

/** Deletes a file: a fresh code (the database answers step_up otherwise), the bytes, then the row. When the bytes
 *  cannot be removed the file stays "deleting" (hidden from others; "Couldn't finish deleting · Retry" for its
 *  uploader and admins) and the answer is "unavailable". */
export async function deleteFile(input: unknown): Promise<ActionResult<null>> {
  const parsed = fileIdInput.safeParse(input);
  if (!parsed.success) return invalid();
  const { supabase } = await requireSession();
  const begun = await supabase.rpc("begin_file_delete", { p_id: parsed.data.id });
  if (begun.error) return toActionFailure(begun.error);
  const removed = await supabase.storage.from(BUCKET).remove([begun.data as string]);
  if (removed.error) return { ok: false, error: "unavailable" };
  const { error } = await supabase.rpc("finish_file_delete", { p_id: parsed.data.id });
  if (error) return toActionFailure(error);
  return { ok: true, data: null };
}
