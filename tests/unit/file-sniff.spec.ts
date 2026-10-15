import { expect, test } from "@playwright/test";
import { HEAD_BYTES, TAIL_BYTES, sniffFile, zipEntryNames } from "@/lib/files/sniff";
import type { FileMime } from "@/lib/files/types";
import { DOCX, XLSX, makeZip } from "./helpers/zip";

// sniffFile (Day 4 design 5.7, threat 23): what the browser, the finish step and every open use to decide that a file
// is what its type says. Fixtures are built here byte by byte (no real documents in the repo).
const enc = new TextEncoder();
const W = "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as FileMime;
const X = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" as FileMime;
function sniff(mime: FileMime, bytes: Uint8Array) {
  return sniffFile({ mime, size: bytes.length, head: bytes.subarray(0, HEAD_BYTES), tail: bytes.subarray(Math.max(0, bytes.length - TAIL_BYTES)) });
}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
const PDF = enc.encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

test("sniff_real_types: PDF, PNG, JPEG, Word and Excel pass as themselves", () => {
  expect(sniff("application/pdf", PDF)).toBe(true);
  expect(sniff("image/png", PNG)).toBe(true);
  expect(sniff("image/jpeg", JPG)).toBe(true);
  expect(sniff(W, makeZip(DOCX))).toBe(true);
  expect(sniff(X, makeZip(XLSX))).toBe(true);
});

test("sniff_wrong_type: each type refuses the others", () => {
  expect(sniff("application/pdf", PNG)).toBe(false);
  expect(sniff("image/png", JPG)).toBe(false);
  expect(sniff("image/jpeg", PDF)).toBe(false);
  expect(sniff(W, makeZip(XLSX))).toBe(false); // an Excel file named .docx
  expect(sniff(X, makeZip(DOCX))).toBe(false);
  expect(sniff(W, PDF)).toBe(false);
});

test("sniff_exe_renamed_pdf, sniff_html_renamed_pdf, sniff_svg and the %PDF polyglot in HTML", () => {
  expect(sniff("application/pdf", new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0, 0, 0]))).toBe(false); // MZ
  expect(sniff("application/pdf", enc.encode("<!doctype html><script>alert(1)</script>"))).toBe(false);
  expect(sniff("image/png", enc.encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'))).toBe(false);
  expect(sniff("application/pdf", enc.encode("<html><body>%PDF-1.4 <script>x()</script></body></html>"))).toBe(false);
  expect(sniff("application/pdf", enc.encode(" %PDF-1.4"))).toBe(false); // not at the very start
});

test("sniff_docm_renamed_docx and xlsm renamed xlsx: macros (vbaProject.bin) are refused", () => {
  expect(sniff(W, makeZip([...DOCX, { name: "word/vbaProject.bin" }]))).toBe(false);
  expect(sniff(X, makeZip([...XLSX, { name: "xl/vbaProject.bin" }]))).toBe(false);
  expect(sniff(X, makeZip([...XLSX, { name: "xl/VBAPROJECT.BIN" }]))).toBe(false);
  expect(sniff(W, makeZip([{ name: "vbaProject.bin" }, ...DOCX]))).toBe(false);
});

test("sniff_zip_count_understated: a count one short of the directory cannot hide vbaProject.bin as the last entry", () => {
  // The directory holds 4 entries (its size covers all 4); the end record says 3. A walk by count alone would stop
  // before word/vbaProject.bin and pass the file; readers that walk by the directory's size see the macros.
  const hidden = makeZip([...DOCX, { name: "word/vbaProject.bin" }], { countOverride: DOCX.length });
  expect(zipEntryNames(hidden.length, hidden)).toBeNull();
  expect(sniff(W, hidden)).toBe(false);
  // The same short count with no macro part is refused too (the count and the size must agree).
  const short = makeZip([...DOCX, { name: "docProps/app.xml" }], { countOverride: DOCX.length });
  expect(sniff(W, short)).toBe(false);
  // The two count fields of the end record must match.
  expect(sniff(W, makeZip(DOCX, { diskCountOverride: DOCX.length - 1 }))).toBe(false);
  expect(sniff(W, makeZip(DOCX, { diskCountOverride: DOCX.length }))).toBe(true);
});

test("sniff_truncated_zip and broken directories give false, never an exception", () => {
  const zip = makeZip(DOCX);
  expect(sniff(W, zip.subarray(0, zip.length - 10))).toBe(false); // end record cut
  expect(sniff(W, zip.subarray(0, 40))).toBe(false);
  const lying = makeZip(DOCX, { countOverride: 7 }); // says 7 entries, has 3
  expect(sniff(W, lying)).toBe(false);
  const noTypes = makeZip([{ name: "word/document.xml" }]);
  expect(sniff(W, noTypes)).toBe(false);
  // A comment after the directory is allowed (the end record is found from the end).
  expect(sniff(W, makeZip(DOCX, { comment: "made by a tool" }))).toBe(true);
  // Random bytes and empty input.
  const noise = new Uint8Array(5000).map((_, i) => (i * 7919) % 256);
  noise.set([0x50, 0x4b, 0x03, 0x04], 0);
  expect(sniff(W, noise)).toBe(false);
  expect(sniffFile({ mime: "application/pdf", size: 0, head: new Uint8Array() })).toBe(false);
  expect(sniffFile({ mime: "text/html" as FileMime, size: 10, head: enc.encode("<html></html>") })).toBe(false);
});

test("sniff_zip_too_many_entries: more than 10,000 entries refused; the tail must hold the directory", () => {
  const many = makeZip([...DOCX, ...Array.from({ length: 10_000 }, (_, i) => ({ name: `f${i}`, data: "" }))]);
  expect(sniff(W, many)).toBe(false);
  // Only the last bytes, not reaching back to the directory's start: cannot be checked, so false.
  const zip = makeZip(DOCX);
  expect(sniffFile({ mime: W, size: zip.length, head: zip.subarray(0, 8), tail: zip.subarray(zip.length - 30) })).toBe(false);
  expect(zipEntryNames(zip.length, zip)).toEqual(["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);
});

test("Word without its tail is not checked (false)", () => {
  const zip = makeZip(DOCX);
  expect(sniffFile({ mime: W, size: zip.length, head: zip })).toBe(false);
});
