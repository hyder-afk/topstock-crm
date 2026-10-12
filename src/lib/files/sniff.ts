import type { FileMime } from "@/lib/files/types";

// Is this file what its type says? (Day 4 design 5.7, threat 23.) Shared by the browser (before an upload), the server
// (after the upload, before the file is marked ready) and the open route (every time someone opens it). It reads only
// the first bytes and, for Word and Excel, the zip's directory at the end of the file: nothing is decompressed (no zip
// bomb), every read is bounds-checked, and an odd file gives false, never an exception.
//  - PDF: starts with "%PDF-" (a page that only contains "%PDF" somewhere is not a PDF).
//  - PNG: the 8-byte signature. JPEG: FF D8 FF.
//  - Word / Excel: a zip ("PK\3\4") whose central directory (found from the end-of-directory record) lists
//    "[Content_Types].xml" and "word/document.xml" (Word) or "xl/workbook.xml" (Excel), has at most 10,000 entries, and
//    has no "vbaProject.bin" (macros) anywhere.

/** Bytes to read from the start of a file, and from its end for Word and Excel (enough for 10,000 directory entries). */
export const HEAD_BYTES = 8192;
export const TAIL_BYTES = 1_048_576;
export const MAX_ZIP_ENTRIES = 10_000;

export type SniffInput = {
  mime: FileMime;
  /** The file's size in bytes. */
  size: number;
  /** Its first bytes (at least 8; HEAD_BYTES is plenty). */
  head: Uint8Array;
  /** Its last bytes (Word and Excel only; up to TAIL_BYTES). Must end at the end of the file. */
  tail?: Uint8Array;
};

const startsWith = (bytes: Uint8Array, sig: number[]) => bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b);
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const ZIP_LOCAL = [0x50, 0x4b, 0x03, 0x04];

function u16(b: Uint8Array, at: number) {
  return b[at] | (b[at + 1] << 8);
}
function u32(b: Uint8Array, at: number) {
  return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)) + b[at + 3] * 0x1000000;
}

/** The entry names of a zip's central directory, read from the file's tail; null when it cannot be read safely. */
export function zipEntryNames(size: number, tail: Uint8Array): string[] | null {
  if (tail.length < 22 || tail.length > size) return null;
  const tailStart = size - tail.length;
  // The end-of-central-directory record: 22 bytes plus a comment of at most 65,535, searched from the end.
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0 && i >= tail.length - 22 - 65_535; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
      if (i + 22 + u16(tail, i + 20) === tail.length) {
        eocd = i;
        break;
      }
    }
  }
  if (eocd < 0) return null;
  const count = u16(tail, eocd + 10);
  const cdSize = u32(tail, eocd + 12);
  const cdOffset = u32(tail, eocd + 16);
  // Zip64 markers, a split archive, or more entries than any Office file has: refused.
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff || u16(tail, eocd + 4) !== 0 || count > MAX_ZIP_ENTRIES) return null;
  if (cdOffset + cdSize > tailStart + eocd) return null;
  let at = cdOffset - tailStart;
  if (at < 0) return null; // the directory starts before the bytes we have
  const end = at + cdSize;
  const names: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: false });
  for (let n = 0; n < count; n++) {
    if (at + 46 > end || u32(tail, at) !== 0x02014b50) return null;
    const nameLen = u16(tail, at + 28);
    const extraLen = u16(tail, at + 30);
    const commentLen = u16(tail, at + 32);
    const next = at + 46 + nameLen + extraLen + commentLen;
    if (next > end) return null;
    names.push(decoder.decode(tail.subarray(at + 46, at + 46 + nameLen)));
    at = next;
  }
  return names;
}

function officeOk(mime: FileMime, size: number, head: Uint8Array, tail: Uint8Array | undefined) {
  if (!startsWith(head, ZIP_LOCAL) || !tail) return false;
  const names = zipEntryNames(size, tail);
  if (!names) return false;
  const lower = names.map((n) => n.toLowerCase());
  if (lower.some((n) => n === "vbaproject.bin" || n.endsWith("/vbaproject.bin"))) return false;
  if (!names.includes("[Content_Types].xml")) return false;
  const main = mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ? "word/document.xml" : "xl/workbook.xml";
  return names.includes(main);
}

/** True when the bytes are the declared type. Never throws. */
export function sniffFile({ mime, size, head, tail }: SniffInput): boolean {
  try {
    if (!Number.isSafeInteger(size) || size < 1 || head.length === 0) return false;
    switch (mime) {
      case "application/pdf":
        return startsWith(head, PDF);
      case "image/png":
        return startsWith(head, PNG);
      case "image/jpeg":
        return startsWith(head, JPEG);
      case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
        return officeOk(mime, size, head, tail);
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/** Whether a type needs the tail of the file (the zip directory). */
export function needsTail(mime: FileMime) {
  return mime.startsWith("application/vnd.openxmlformats");
}
