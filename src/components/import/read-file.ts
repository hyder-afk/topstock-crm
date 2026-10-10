// Reading a chosen CSV file, in this browser only (it is never uploaded as a file): decoded once (UTF-8, or Western
// European if that fails), hashed (the "same file" checks), parsed in slices so the screen keeps responding, and the
// lists the matching screen needs prepared. Used by the Choose step and by the results screen ("Choose the file").
import { prepareAnalysis } from "@/components/import/analysis";
import {
  ImportFileError,
  checkFileMeta,
  cleanText,
  decodeBytes,
  headerStorageKey,
  parseCsvText,
  prepareCountryNames,
  sha256Hex,
  type ParseProgress,
  type ParsedCsv,
} from "@/lib/import";

export type LoadedFile = {
  /** The file name without invisible characters (bidi overrides, zero-width): it is shown to every admin. */
  name: string;
  size: number;
  sha256: string;
  /** Hash of the header row: where this browser remembers the column matching (no header text in storage). */
  headerKey: string;
  encoding: "utf-8" | "windows-1252";
  parsed: ParsedCsv;
};

const stopIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new ImportFileError("aborted");
};

/** Throws ImportFileError (with a code for the message) when the file is refused, or "aborted" when the signal fires. */
export async function readImportFile(
  picked: File,
  options: { signal?: AbortSignal; onProgress?: (progress: ParseProgress) => void } = {},
): Promise<LoadedFile> {
  const { signal, onProgress } = options;
  checkFileMeta(picked);
  const bytes = new Uint8Array(await picked.arrayBuffer());
  stopIfAborted(signal);
  const decoded = decodeBytes(bytes);
  // The matching screen needs the country names: build them while the file is read, between parsing slices.
  setTimeout(prepareCountryNames, 0);
  const sha256 = await sha256Hex(bytes);
  stopIfAborted(signal);
  const parsed = await parseCsvText(decoded.text, { sepHint: decoded.sepHint, onProgress, signal });
  const headerKey = await headerStorageKey(parsed.rawHeaders);
  await prepareAnalysis(parsed.headers, parsed.records);
  stopIfAborted(signal);
  return { name: cleanText(picked.name), size: picked.size, sha256, headerKey, encoding: decoded.encoding, parsed };
}
