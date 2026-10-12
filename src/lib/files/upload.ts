import type { ActionFailure } from "@/lib/db-errors";
import { typeOf } from "@/lib/files/name";
import { HEAD_BYTES, TAIL_BYTES, needsTail, sniffFile } from "@/lib/files/sniff";
import { BUCKET, MAX_FILE_BYTES, type FileMime } from "@/lib/files/types";

// The browser's side of an upload (Day 4 design 5.7): check a chosen file before anything is sent, then send its bytes
// straight to Supabase Storage with XMLHttpRequest, whose upload progress drives a real progress bar (no spinner).
// The server checks the stored bytes again before the file is ready, and again on every open.

export type LocalCheck =
  | { ok: true; mime: FileMime }
  | { ok: false; reason: "tooBig" | "empty" | "type" }
  | { ok: false; reason: "mismatch"; mime: FileMime };

/** Size, type (browser type or extension) and the bytes themselves (sniffFile), before any upload. */
export async function checkLocalFile(file: File): Promise<LocalCheck> {
  if (file.size > MAX_FILE_BYTES) return { ok: false, reason: "tooBig" };
  if (file.size === 0) return { ok: false, reason: "empty" };
  const mime = typeOf(file);
  if (!mime) return { ok: false, reason: "type" };
  try {
    const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
    const tail = needsTail(mime) ? new Uint8Array(await file.slice(Math.max(0, file.size - TAIL_BYTES)).arrayBuffer()) : undefined;
    return sniffFile({ mime, size: file.size, head, tail }) ? { ok: true, mime } : { ok: false, reason: "mismatch", mime };
  } catch {
    return { ok: false, reason: "mismatch", mime };
  }
}

/** What an upload's line says when it fails (the Files tab words each one: Files.errors.<key>). */
export type UploadError = "tooBig" | "empty" | "type" | "mismatch" | "quota" | "rateLimited" | "tooManyPending" | "connection" | "tooMany" | "unavailable";

/** A refusal from beginUpload or finishUpload as an upload line. Only a refused type or size is worded as such; a
 *  refused name or lead (hints file_name, file_lead) or a refusal without a hint is "unavailable". */
export function failureToUpload(f: ActionFailure): UploadError {
  switch (f.error) {
    case "quota":
      return "quota";
    case "rate_limited":
      return "rateLimited";
    case "busy":
      return "tooManyPending";
    case "type_mismatch":
      return "mismatch";
    case "invalid":
      return f.hint === "file_size" ? "tooBig" : f.hint === "file_type" ? "type" : "unavailable";
    default:
      return "unavailable";
  }
}

export type UploadOutcome = "done" | "cancelled" | "failed" | "refused";

/** The storage REST path of an object (each segment encoded; the path is org/lead/id.ext from the server). */
export function objectUrl(supabaseUrl: string, path: string) {
  return `${supabaseUrl.replace(/\/$/, "")}/storage/v1/object/${BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * POST the bytes to {SUPABASE_URL}/storage/v1/object/lead-files/{path} with the person's own session token (the
 * bucket's policies run as them), no upsert (an existing object is never replaced), the declared type and
 * `cache-control: max-age=0`. Resolves with what happened; never rejects. `signal` cancels.
 */
export function uploadBytes(o: {
  supabaseUrl: string;
  anonKey: string;
  token: string;
  path: string;
  file: Blob;
  mime: FileMime;
  onProgress: (fraction: number) => void;
  signal: AbortSignal;
}): Promise<UploadOutcome> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    if (o.signal.aborted) return resolve("cancelled");
    o.signal.addEventListener("abort", onAbort, { once: true });
    xhr.open("POST", objectUrl(o.supabaseUrl, o.path));
    xhr.setRequestHeader("Authorization", `Bearer ${o.token}`);
    xhr.setRequestHeader("apikey", o.anonKey);
    xhr.setRequestHeader("x-upsert", "false");
    xhr.setRequestHeader("content-type", o.mime);
    xhr.setRequestHeader("cache-control", "max-age=0");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) o.onProgress(Math.min(1, e.loaded / e.total));
    };
    const finish = (outcome: UploadOutcome) => {
      o.signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    xhr.onload = () => finish(xhr.status >= 200 && xhr.status < 300 ? "done" : xhr.status >= 400 && xhr.status < 500 ? "refused" : "failed");
    xhr.onerror = () => finish("failed");
    xhr.ontimeout = () => finish("failed");
    xhr.onabort = () => finish("cancelled");
    xhr.send(o.file);
  });
}
