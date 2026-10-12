import { HEAD_BYTES, TAIL_BYTES, needsTail, sniffFile } from "@/lib/files/sniff";
import { MAX_FILE_BYTES, type FileMime } from "@/lib/files/types";

// Reading a stored file's bytes back for sniffFile (Day 4 design 5.7; spike S3), without the network part, so the unit
// tests can run it against Range-honouring and Range-ignoring answers. It asks for the first 8 KiB and, for Word and
// Excel, the last 1 MiB. When the store answers 206, those ranges are all it reads. When it ignores Range (200, the
// whole body), it reads the stream itself: the first 8 KiB for PDF and images, or the whole file (at most 10 MiB) for
// Word and Excel, keeping the head and the last bytes, and cancels the rest.

export type Fetcher = (range: string, timeoutMs: number) => Promise<Response>;
export type StoredCheck = { ok: boolean; rangeHonoured: boolean | null };

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

/** Reads what sniffFile needs and runs it. False on any failure (status, timeout, short body, odd bytes). */
export async function readAndSniff(fetcher: Fetcher, mime: FileMime, size: number, budgetMs = 3000): Promise<StoredCheck> {
  try {
    const deadline = Date.now() + budgetMs;
    const office = needsTail(mime);
    const first = await read(fetcher, `bytes=0-${HEAD_BYTES - 1}`, HEAD_BYTES, budgetMs, office);
    if (!first) return { ok: false, rangeHonoured: null };
    let head = first.bytes.subarray(0, HEAD_BYTES);
    let tail: Uint8Array | undefined;
    if (office) {
      if (first.whole) {
        if (first.bytes.length !== size) return { ok: false, rangeHonoured: false };
        tail = first.bytes.subarray(Math.max(0, size - TAIL_BYTES));
      } else {
        const want = Math.min(size, TAIL_BYTES);
        const last = await read(fetcher, `bytes=-${want}`, want, Math.max(1, deadline - Date.now()), true);
        if (!last) return { ok: false, rangeHonoured: true };
        if (last.whole) {
          if (last.bytes.length !== size) return { ok: false, rangeHonoured: false };
          head = last.bytes.subarray(0, HEAD_BYTES);
          tail = last.bytes.subarray(Math.max(0, size - TAIL_BYTES));
        } else {
          if (last.bytes.length !== want) return { ok: false, rangeHonoured: true };
          tail = last.bytes;
        }
      }
    }
    return { ok: sniffFile({ mime, size, head, tail }), rangeHonoured: !first.whole };
  } catch {
    return { ok: false, rangeHonoured: null };
  }
}
