// Splits the stage payload into calls of at most 1,000 rows and 750 KB of UTF-8 JSON (design 3.6), under the
// unchanged 1 MB server action limit.
import { ImportRulesError, LIMITS } from "./rules";
import type { ImportRow } from "./schema";

const utf8 = new TextEncoder();

export type ChunkLimits = { maxRows?: number; maxBytes?: number };

/** Groups rows in order; each group's JSON array (`[a,b,...]`) stays within both limits. */
export function chunkRows<T extends ImportRow>(rows: readonly T[], limits: ChunkLimits = {}): T[][] {
  const maxRows = limits.maxRows ?? LIMITS.chunkRows;
  const maxBytes = limits.maxBytes ?? LIMITS.chunkBytes;
  const chunks: T[][] = [];
  let current: T[] = [];
  let bytes = 2; // "[" and "]"
  for (const row of rows) {
    const size = utf8.encode(JSON.stringify(row)).length;
    if (size + 2 > maxBytes) throw new ImportRulesError("row_too_big");
    const added = size + (current.length > 0 ? 1 : 0); // the comma between rows
    if (current.length > 0 && (current.length >= maxRows || bytes + added > maxBytes)) {
      chunks.push(current);
      current = [];
      bytes = 2;
    }
    bytes += size + (current.length > 0 ? 1 : 0);
    current.push(row);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
