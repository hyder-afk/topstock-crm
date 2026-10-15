import { expect, test } from "@playwright/test";
import { UNSAFE_NAME, cleanFileName, extensionOf, splitName, typeOf } from "@/lib/files/name";
import { FILE_NAME_MAX } from "@/lib/files/types";

// cleanFileName (Day 4 design 5.7, threat 24): every name the server stores goes through it, so the database's name
// rule (files_name_check) is never what refuses a real file.
const W = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

test("the extension follows the type, never the name", () => {
  expect(cleanFileName("photo.png", "image/jpeg")).toBe("photo.jpg");
  expect(cleanFileName("Devis", "application/pdf")).toBe("Devis.pdf");
  expect(cleanFileName("Devis.PDF", "application/pdf")).toBe("Devis.pdf");
  expect(cleanFileName("scan.jpeg", "image/jpeg")).toBe("scan.jpg");
  expect(cleanFileName("tarifs.xlsx", W)).toBe("tarifs.docx");
  expect(cleanFileName("report.v2", "application/pdf")).toBe("report.v2.pdf");
  expect(cleanFileName("malware.exe", "application/pdf")).toBe("malware.exe.pdf");
});

test("invisible, bidi and control characters go; slashes become spaces; never empty", () => {
  expect(cleanFileName("in\u202Egnp.exe.pdf", "application/pdf")).toBe("ingnp.exe.pdf");
  expect(cleanFileName("a​b﻿c\u0007.pdf", "application/pdf")).toBe("abc.pdf");
  expect(cleanFileName("../../etc/passwd.pdf", "application/pdf")).toBe("etc passwd.pdf");
  expect(cleanFileName('say "hi"\\there.pdf', "application/pdf")).toBe("say hi there.pdf");
  expect(cleanFileName("   ", "application/pdf")).toBe("file.pdf");
  expect(cleanFileName("\u202E\u2066", "image/png")).toBe("file.png");
  expect(cleanFileName("...pdf", "application/pdf")).toBe("file.pdf");
  expect(cleanFileName("Devis n°12 — été 🧾.pdf", "application/pdf")).toBe("Devis n°12 — été 🧾.pdf");
  // NFC: a decomposed "é" becomes one character.
  expect(cleanFileName("été.pdf", "application/pdf")).toBe("été.pdf");
});

test("at most 180 characters, cut before the extension, emoji kept whole", () => {
  const long = cleanFileName(`${"a".repeat(300)}.pdf`, "application/pdf");
  expect(long.length).toBe(FILE_NAME_MAX);
  expect(long.endsWith(".pdf")).toBe(true);
  const emoji = cleanFileName(`${"🧾".repeat(200)}.pdf`, "application/pdf");
  expect(Array.from(emoji).length).toBeLessThanOrEqual(FILE_NAME_MAX);
  expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

test("file_name_invisible_refused: every cleaned name passes the database's rule", () => {
  for (const cp of [1, 9, 10, 31, 127, 133, 0x61c, 0x180e, 0x200b, 0x200f, 0x202e, 0x2066, 0xfeff, 0xe0041, 0x2f, 0x5c, 0x22]) {
    const name = `x${String.fromCodePoint(cp)}y.pdf`;
    expect(UNSAFE_NAME.test(name), `U+${cp.toString(16)}`).toBe(true);
    expect(UNSAFE_NAME.test(cleanFileName(name, "application/pdf"))).toBe(false);
  }
});

test("typeOf: the browser's type, or the extension when the browser gives none", () => {
  expect(typeOf({ name: "a.pdf", type: "application/pdf" })).toBe("application/pdf");
  expect(typeOf({ name: "a.docx", type: "" })).toBe(W);
  expect(typeOf({ name: "a.docx", type: "application/octet-stream" })).toBe(W);
  expect(typeOf({ name: "a.pdf", type: "text/html" })).toBe(null);
  expect(typeOf({ name: "a.heic", type: "image/heic" })).toBe(null);
  expect(typeOf({ name: "a.svg", type: "" })).toBe(null);
  expect(extensionOf("archive.tar.gz")).toBe("gz");
  expect(extensionOf(".env")).toBe("");
  expect(splitName("Devis printemps.pdf")).toEqual({ stem: "Devis printemps", ext: ".pdf" });
});
