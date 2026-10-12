// Reading a chosen stock sheet in this browser only (it is never uploaded as a file): decoded once (UTF-8, or Western
// European if that fails), hashed, parsed in slices so the screen keeps responding. Day 3b's readers, with the stock
// sheet's own row limit (5,000 rows).
import {
  ImportFileError,
  checkFileMeta,
  cleanText,
  decodeBytes,
  parseCsvText,
  sha256Hex,
  type ParseProgress,
  type ParsedCsv,
} from "@/lib/import";
import { STOCK_LIMITS, stockHeaderFingerprint } from "@/lib/stock-import";

export type LoadedStockFile = {
  name: string;
  size: number;
  sha256: string;
  /** Hash of the header row: where this browser remembers the column matching (no header text in storage). */
  headerKey: string;
  encoding: "utf-8" | "windows-1252";
  parsed: ParsedCsv;
};

export async function readStockFile(
  picked: File,
  options: { signal?: AbortSignal; onProgress?: (progress: ParseProgress) => void } = {},
): Promise<LoadedStockFile> {
  const { signal, onProgress } = options;
  checkFileMeta(picked);
  const bytes = new Uint8Array(await picked.arrayBuffer());
  if (signal?.aborted) throw new ImportFileError("aborted");
  const decoded = decodeBytes(bytes);
  const sha256 = await sha256Hex(bytes);
  const parsed = await parseCsvText(decoded.text, { sepHint: decoded.sepHint, onProgress, signal });
  if (parsed.rowCount > STOCK_LIMITS.maxDataRows || parsed.lastRowNo > STOCK_LIMITS.maxRowNo) {
    throw new ImportFileError("too_many_rows", STOCK_LIMITS.maxRowNo + 1);
  }
  const headerKey = await sha256Hex(new TextEncoder().encode(stockHeaderFingerprint(parsed.rawHeaders)));
  if (signal?.aborted) throw new ImportFileError("aborted");
  return { name: cleanText(picked.name), size: picked.size, sha256, headerKey, encoding: decoded.encoding, parsed };
}
