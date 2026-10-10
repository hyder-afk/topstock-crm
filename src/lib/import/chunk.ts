// Splits the stage payload into calls of at most 1,000 rows and 750 KB of UTF-8 JSON (design 3.6), under the
// unchanged 1 MB server action limit.
import { ImportRulesError, LIMITS } from "./rules";
import type { ImportRow } from "./schema";

export type ChunkLimits = { maxRows?: number; maxBytes?: number };

/** Bytes of a string in UTF-8, without encoding it (a lone surrogate counts 3, as TextEncoder writes U+FFFD). */
export function utf8Length(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Groups rows in order, one group at a time; each group's JSON array (`[a,b,...]`) stays within both limits. Lazy, so
 * the page can send each group before measuring the next (measuring 30,000 rows at once is a visible pause).
 */
export function* iterChunks<T extends ImportRow>(rows: readonly T[], limits: ChunkLimits = {}): Generator<T[]> {
  const maxRows = limits.maxRows ?? LIMITS.chunkRows;
  const maxBytes = limits.maxBytes ?? LIMITS.chunkBytes;
  let current: T[] = [];
  let bytes = 2; // "[" and "]"
  for (const row of rows) {
    const size = utf8Length(JSON.stringify(row));
    if (size + 2 > maxBytes) throw new ImportRulesError("row_too_big");
    const added = size + (current.length > 0 ? 1 : 0); // the comma between rows
    if (current.length > 0 && (current.length >= maxRows || bytes + added > maxBytes)) {
      yield current;
      current = [];
      bytes = 2;
    }
    bytes += size + (current.length > 0 ? 1 : 0);
    current.push(row);
  }
  if (current.length > 0) yield current;
}

/** All the groups at once (see iterChunks). */
export function chunkRows<T extends ImportRow>(rows: readonly T[], limits: ChunkLimits = {}): T[][] {
  return [...iterChunks(rows, limits)];
}
