import { expect, test } from "@playwright/test";
import { canRetry, checkLocalFile, failureToUpload, objectUrl } from "@/lib/files/upload";
import { DOCX, makeZip } from "./helpers/zip";

// The browser's checks before an upload (Day 4 design 5.7): too big, empty, wrong type and wrong bytes are refused
// before anything is sent (too_big_rejected_before_upload, renamed_exe_rejected), and the storage path is encoded.
const W = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

test("too_big_rejected_before_upload, empty, type, renamed_exe_rejected", async () => {
  const big = new File([new Uint8Array(10_485_761)], "big.pdf", { type: "application/pdf" });
  expect(await checkLocalFile(big)).toEqual({ ok: false, reason: "tooBig" });
  expect(await checkLocalFile(new File([], "empty.pdf", { type: "application/pdf" }))).toEqual({ ok: false, reason: "empty" });
  expect(await checkLocalFile(new File(["<svg/>"], "x.svg", { type: "image/svg+xml" }))).toEqual({ ok: false, reason: "type" });
  const exe = new File([new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0])], "invoice.pdf", { type: "application/pdf" });
  expect(await checkLocalFile(exe)).toEqual({ ok: false, reason: "mismatch", mime: "application/pdf" });
});

test("a real-looking PDF and Word file pass, with their type", async () => {
  expect(await checkLocalFile(new File(["%PDF-1.7\n%%EOF"], "devis.pdf", { type: "application/pdf" }))).toEqual({ ok: true, mime: "application/pdf" });
  expect(await checkLocalFile(new File([makeZip(DOCX)], "offre.docx", { type: "" }))).toEqual({ ok: true, mime: W });
  expect(await checkLocalFile(new File([makeZip([...DOCX, { name: "word/vbaProject.bin" }])], "offre.docx", { type: W }))).toEqual({
    ok: false,
    reason: "mismatch",
    mime: W,
  });
});

test("objectUrl encodes each path segment under the lead-files bucket", () => {
  expect(objectUrl("https://x.supabase.co/", "o/l/f.pdf")).toBe("https://x.supabase.co/storage/v1/object/lead-files/o/l/f.pdf");
  expect(objectUrl("http://127.0.0.1:54321", "a b/c?d.pdf")).toBe("http://127.0.0.1:54321/storage/v1/object/lead-files/a%20b/c%3Fd.pdf");
});

// Verifier 4d finding 7: what an upload's refusal says. Only a refused type or size is worded as such; a refused name
// or lead (the database's file_name and file_lead hints, or a refusal without a hint) is "unavailable", never "Only
// PDF, PNG, JPG…".
test("failureToUpload: file_type and file_size are worded; file_name, file_lead and no hint are unavailable", () => {
  expect(failureToUpload({ ok: false, error: "invalid", hint: "file_type" })).toBe("type");
  expect(failureToUpload({ ok: false, error: "invalid", hint: "file_size" })).toBe("tooBig");
  expect(failureToUpload({ ok: false, error: "invalid", hint: "file_name" })).toBe("unavailable");
  expect(failureToUpload({ ok: false, error: "invalid", hint: "file_lead" })).toBe("unavailable");
  expect(failureToUpload({ ok: false, error: "invalid" })).toBe("unavailable");
  expect(failureToUpload({ ok: false, error: "quota" })).toBe("quota");
  expect(failureToUpload({ ok: false, error: "rate_limited" })).toBe("rateLimited");
  expect(failureToUpload({ ok: false, error: "busy" })).toBe("tooManyPending");
  expect(failureToUpload({ ok: false, error: "type_mismatch" })).toBe("mismatch");
  expect(failureToUpload({ ok: false, error: "not_found" })).toBe("unavailable");
});

// Verifier 4d round 2 finding 9: a file the browser cannot read (moved or changed after it was picked, a cloud
// placeholder, no permission) is "unreadable", never called fake ("mismatch"); a fake file still is.
test("checkLocalFile: a read that fails is unreadable, not mismatch", async () => {
  const broken = (name: string, type: string) => {
    const f = new File([new Uint8Array(64).fill(0x25)], name, { type });
    // File.slice() returns a Blob whose arrayBuffer() rejects, as Chrome and Safari do with NotReadableError.
    Object.defineProperty(f, "slice", {
      value: () => ({ arrayBuffer: () => Promise.reject(new DOMException("The file could not be read.", "NotReadableError")) }),
    });
    return f;
  };
  expect(await checkLocalFile(broken("devis.pdf", "application/pdf"))).toEqual({ ok: false, reason: "unreadable" });
  expect(await checkLocalFile(broken("offre.docx", W))).toEqual({ ok: false, reason: "unreadable" });
  const fake = new File([new Uint8Array([0x4d, 0x5a, 0x90, 0])], "facture.pdf", { type: "application/pdf" });
  expect(await checkLocalFile(fake)).toEqual({ ok: false, reason: "mismatch", mime: "application/pdf" });
});

test("canRetry: only failures that are not the file's own fault offer Try again", () => {
  for (const e of ["connection", "unavailable", "tooMany"] as const) expect(canRetry(e)).toBe(true);
  for (const e of ["tooBig", "empty", "type", "unreadable", "mismatch", "quota", "rateLimited", "tooManyPending"] as const) expect(canRetry(e)).toBe(false);
});
