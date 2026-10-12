import { HEAD_BYTES, TAIL_BYTES, needsTail, sniffFile } from "@/lib/files/sniff";
import { MAX_FILE_BYTES, type FileMime } from "@/lib/files/types";

// Reading a stored file's bytes back for sniffFile (Day 4 design 5.7; spike S3), without the network part, so the unit
// tests can run it against Range-honouring and Range-ignoring answers. It asks for the first 8 KiB and, for Word and
// Excel, the last 1 MiB. When the store answers 206, those ranges are all it reads. When it ignores Range (200, the
// whole body), it reads the stream itself: the first 8 KiB for PDF and images, or the whole file (at most 10 MiB) for
// Word and Excel, keeping the head and the last bytes, and cancels the rest.
// A failed check says why: "mismatch" only when the bytes were read in full and sniffFile refused them; "unreadable"
// for everything else (no link, a Storage error, the time budget, a stream cut short), so a slow read is never taken
// for a fake file (finishUpload deletes only on "mismatch").

export type Fetcher = (range: string, timeoutMs: number) => Promise<Response>;
export type StoredCheck =
  | { ok: true; rangeHonoured: boolean }
  | { ok: false; reason: "unreadable" | "mismatch"; rangeHonoured: boolean | null };

const unreadable = (rangeHonoured: boolean | null): StoredCheck => ({ ok: false, reason: "unreadable", rangeHonoured });

async function read(fetcher: Fetcher, range: string, want: number, timeoutMs: number, wholeIfIgnored: boolean) {
  const res = await fetcher(range, timeoutMs);
  if (res.status !== 206 && res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const whole = res.status === 200;
  const reader = res.body?.getReader();
  if (!reader) return null;
  const limit = whole ? (wholeIfIgnored ? MAX_FILE_BYTES + 1 : want) : want + 1;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total >= limit) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return { bytes, whole };
}

/** Reads what sniffFile needs and runs it: ok, or why not ("unreadable": status, timeout, short body; "mismatch": the
 *  bytes, read in full, are not what they claim). */
export async function readAndSniff(fetcher: Fetcher, mime: FileMime, size: number, budgetMs = 3000): Promise<StoredCheck> {
  try {
    const deadline = Date.now() + budgetMs;
    const office = needsTail(mime);
    const first = await read(fetcher, `bytes=0-${HEAD_BYTES - 1}`, HEAD_BYTES, budgetMs, office);
    if (!first) return unreadable(null);
    let head = first.bytes.subarray(0, HEAD_BYTES);
    let tail: Uint8Array | undefined;
    if (office) {
      if (first.whole) {
        if (first.bytes.length !== size) return unreadable(false);
        tail = first.bytes.subarray(Math.max(0, size - TAIL_BYTES));
      } else {
        const want = Math.min(size, TAIL_BYTES);
        const last = await read(fetcher, `bytes=-${want}`, want, Math.max(1, deadline - Date.now()), true);
        if (!last) return unreadable(true);
        if (last.whole) {
          if (last.bytes.length !== size) return unreadable(false);
          head = last.bytes.subarray(0, HEAD_BYTES);
          tail = last.bytes.subarray(Math.max(0, size - TAIL_BYTES));
        } else {
          if (last.bytes.length !== want) return unreadable(true);
          tail = last.bytes;
        }
      }
    }
    const rangeHonoured = !first.whole;
    return sniffFile({ mime, size, head, tail }) ? { ok: true, rangeHonoured } : { ok: false, reason: "mismatch", rangeHonoured };
  } catch {
    return unreadable(null);
  }
}

/** What finishUpload does with a check: mark it ready (the database still matches size and type), delete it as a fake
 *  file (only bytes read in full and refused), or answer "unavailable" and leave the pending row for Cancel or the
 *  15-minute cleanup (any failure to read: a real file is never deleted because Storage was slow). */
export function afterUploadCheck(check: StoredCheck): "finish" | "discard" | "keep_pending" {
  if (check.ok) return "finish";
  return check.reason === "mismatch" ? "discard" : "keep_pending";
}
