import { expect, test } from "@playwright/test";
import { checkFileMeta, decodeBytes, decodeWindows1252, sha256Hex } from "../../src/lib/import/decode";
import { ImportFileError, LIMITS } from "../../src/lib/import/rules";

const utf8 = (s: string) => new TextEncoder().encode(s);

function fileError(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ImportFileError);
    return (error as ImportFileError).code;
  }
  throw new Error("expected an ImportFileError");
}

test.describe("decode", () => {
  test("UTF-8 with and without BOM", () => {
    expect(decodeBytes(utf8("Société,Ville\nCafé,Liège\n"))).toEqual({
      text: "Société,Ville\nCafé,Liège\n",
      encoding: "utf-8",
      sepHint: null,
    });
    const bom = decodeBytes(Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8("Name\nA\n")]));
    expect(bom.text).toBe("Name\nA\n");
    expect(bom.encoding).toBe("utf-8");
  });

  test("invalid UTF-8 falls back to Windows-1252", () => {
    // "Société;Ville\r\nCafé €;Liège" in Windows-1252: é = E9, € = 80, è = E8.
    const bytes = Uint8Array.from([
      ...utf8("Soci"), 0xe9, ...utf8("t"), 0xe9, ...utf8(";Ville\r\nCaf"), 0xe9, 0x20, 0x80, ...utf8(";Li"), 0xe8, ...utf8("ge\r\n"),
    ]);
    const decoded = decodeBytes(bytes);
    expect(decoded.encoding).toBe("windows-1252");
    expect(decoded.text).toBe("Société;Ville\r\nCafé €;Liège\r\n");
  });

  test("Windows-1252 bytes 0x80-0x9F follow the WHATWG table, also in long files", () => {
    expect(decodeWindows1252(Uint8Array.from([0x80, 0x92, 0x9c, 0x8c, 0x96, 0x81, 0xe9, 0x41]))).toBe(
      "€’œŒ–\u0081éA",
    );
    const long = new Uint8Array(100_000).fill(0x9c);
    const text = decodeWindows1252(long);
    expect(text).toHaveLength(100_000);
    expect(text).toBe("œ".repeat(100_000));
  });

  test("an Excel sep= first line is removed and returned as the separator", () => {
    expect(decodeBytes(utf8("sep=;\r\na;b\r\n1;2\r\n"))).toMatchObject({ text: "a;b\r\n1;2\r\n", sepHint: ";" });
    expect(decodeBytes(utf8("\"sep=,\"\na,b\n"))).toMatchObject({ text: "a,b\n", sepHint: "," });
    expect(decodeBytes(utf8("SEP=|\na|b\n"))).toMatchObject({ text: "a|b\n", sepHint: "|" });
    // Anything else is left alone.
    expect(decodeBytes(utf8("sep=x\na\n"))).toMatchObject({ text: "sep=x\na\n", sepHint: null });
    expect(decodeBytes(utf8("separator,b\n1,2\n")).sepHint).toBeNull();
  });

  test("Excel files are refused by their magic bytes", () => {
    expect(fileError(() => decodeBytes(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])))).toBe("excel_file");
    expect(fileError(() => decodeBytes(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1])))).toBe("excel_file");
  });

  test("empty, blank, UTF-16 and binary input", () => {
    expect(fileError(() => decodeBytes(new Uint8Array(0)))).toBe("empty");
    expect(fileError(() => decodeBytes(utf8(" \r\n\t\n")))).toBe("empty");
    expect(fileError(() => decodeBytes(Uint8Array.from([0xef, 0xbb, 0xbf])))).toBe("empty");
    expect(fileError(() => decodeBytes(Uint8Array.from([0xff, 0xfe, 0x41, 0x00])))).toBe("not_text");
    expect(fileError(() => decodeBytes(Uint8Array.from([0x41, 0x00, 0x42])))).toBe("not_text");
  });

  test("file name and size are checked before reading", () => {
    expect(() => checkFileMeta({ name: "leads.csv", size: 10 })).not.toThrow();
    expect(() => checkFileMeta({ name: "LEADS.CSV", size: 10 })).not.toThrow();
    expect(() => checkFileMeta({ name: "export.txt", size: LIMITS.maxFileBytes })).not.toThrow();
    expect(fileError(() => checkFileMeta({ name: "leads.xlsx", size: 10 }))).toBe("excel_file");
    expect(fileError(() => checkFileMeta({ name: "old.XLS", size: 10 }))).toBe("excel_file");
    expect(fileError(() => checkFileMeta({ name: "leads.pdf", size: 10 }))).toBe("not_csv");
    expect(fileError(() => checkFileMeta({ name: "leads.csv", size: LIMITS.maxFileBytes + 1 }))).toBe("too_big");
    expect(fileError(() => checkFileMeta({ name: "leads.csv", size: 0 }))).toBe("empty");
  });

  test("SHA-256 in hex", async () => {
    expect(await sha256Hex(utf8("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256Hex(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    // A view into a larger buffer hashes only the view.
    const buffer = utf8("xxabcxx");
    expect(await sha256Hex(buffer.subarray(2, 5))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
