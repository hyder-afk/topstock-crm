// Bytes to text, once, for the whole file (design 3.2). papaparse's file streamer decodes each byte slice on its own and
// can break accented characters at slice boundaries, so the import decodes here and parses the string.
import { DELIMITERS, ImportFileError, LIMITS, type Delimiter } from "./rules";

export type DecodedFile = {
  text: string;
  encoding: "utf-8" | "windows-1252";
  /** Separator from an Excel "sep=;" first line (that line is removed from `text`), else null. */
  sepHint: Delimiter | null;
};

/** Refuses a file by name and size before reading it. */
export function checkFileMeta(file: { name: string; size: number }): void {
  // A spreadsheet gets the "save it as CSV UTF-8" message rather than a generic one.
  if (/\.(xlsx|xlsm|xlsb|xls|ods|numbers)$/i.test(file.name)) throw new ImportFileError("excel_file");
  if (!/\.(csv|txt)$/i.test(file.name)) throw new ImportFileError("not_csv");
  if (file.size > LIMITS.maxFileBytes) throw new ImportFileError("too_big");
  if (file.size === 0) throw new ImportFileError("empty");
}

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((b, i) => bytes[i] === b);
}

const ZIP = [0x50, 0x4b, 0x03, 0x04]; // .xlsx (and any zip)
const OLE = [0xd0, 0xcf, 0x11, 0xe0]; // .xls
const UTF8_BOM = [0xef, 0xbb, 0xbf];
const UTF16_LE = [0xff, 0xfe];
const UTF16_BE = [0xfe, 0xff];
const SEP_LINE = /^"?sep=(.)"?[ \t]*(?:\r\n|\r|\n|$)/i;

// WHATWG windows-1252 for bytes 0x80-0x9F (the rest is Latin-1). Decoded here rather than with
// TextDecoder("windows-1252"): some engines (Node 22) decode that label as ISO-8859-1 and lose "€", "œ", "’".
const CP1252_HIGH = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d,
  0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x009d, 0x017e, 0x0178,
];

export function decodeWindows1252(bytes: Uint8Array): string {
  const parts: string[] = [];
  const size = 0x8000;
  for (let start = 0; start < bytes.length; start += size) {
    const slice = bytes.subarray(start, start + size);
    const units = new Uint16Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      const b = slice[i];
      units[i] = b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : b;
    }
    parts.push(String.fromCharCode(...units));
  }
  return parts.join("");
}

export function decodeBytes(bytes: Uint8Array): DecodedFile {
  if (bytes.length === 0) throw new ImportFileError("empty");
  if (bytes.length > LIMITS.maxFileBytes) throw new ImportFileError("too_big");
  if (startsWith(bytes, ZIP) || startsWith(bytes, OLE)) throw new ImportFileError("excel_file");
  // UTF-16 ("Unicode text" in Excel) and binary files: a CSV never contains NUL bytes.
  if (startsWith(bytes, UTF16_LE) || startsWith(bytes, UTF16_BE)) throw new ImportFileError("not_text");
  const probe = bytes.subarray(0, 64 * 1024);
  if (probe.includes(0)) throw new ImportFileError("not_text");

  const body = startsWith(bytes, UTF8_BOM) ? bytes.subarray(3) : bytes;
  let text: string;
  let encoding: DecodedFile["encoding"];
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
    encoding = "utf-8";
  } catch {
    text = decodeWindows1252(body);
    encoding = "windows-1252";
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  let sepHint: Delimiter | null = null;
  const sep = SEP_LINE.exec(text);
  if (sep && (DELIMITERS as readonly string[]).includes(sep[1])) {
    sepHint = sep[1] as Delimiter;
    text = text.slice(sep[0].length);
  }
  if (text.trim() === "") throw new ImportFileError("empty");
  return { text, encoding, sepHint };
}

/** Lower-case hex SHA-256 of the file (the "same file as before" check), with Web Crypto in the browser and Node. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Web Crypto takes views over a plain ArrayBuffer only; copy anything else (a SharedArrayBuffer view).
  const view =
    bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : Uint8Array.from(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", view);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
