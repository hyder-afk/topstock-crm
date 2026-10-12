import { expect, test } from "@playwright/test";
import { readAndSniff, type Fetcher } from "@/lib/files/stored-bytes";
import { DOCX, makeZip } from "./helpers/zip";

// The check on every open and at finish (Day 4 design 5.7) reads stored bytes back. Spike S3 (does a signed link honour
// Range?) is decided by this fallback: the same answer whether the store sends the asked range (206) or ignores it and
// sends the whole file (200). These fake stores serve a byte array either way and count what they sent.
const W = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const enc = new TextEncoder();

function store(bytes: Uint8Array, honourRange: boolean, chunk = 4096) {
  const sent = { bytes: 0, calls: [] as string[] };
  const fetcher: Fetcher = async (range) => {
    sent.calls.push(range);
    let body = bytes;
    let status = 200;
    if (honourRange) {
      status = 206;
      const m = /^bytes=(\d+)-(\d+)$/.exec(range);
      const s = /^bytes=-(\d+)$/.exec(range);
      body = m ? bytes.subarray(Number(m[1]), Number(m[2]) + 1) : s ? bytes.subarray(Math.max(0, bytes.length - Number(s[1]))) : bytes;
    }
    let at = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= body.length) return controller.close();
        const part = body.subarray(at, at + chunk);
        at += part.length;
        sent.bytes += part.length;
        controller.enqueue(part);
      },
    });
    return new Response(stream, { status });
  };
  return { fetcher, sent };
}

const bigPdf = () => {
  const b = new Uint8Array(3_000_000);
  b.set(enc.encode("%PDF-1.7\n"));
  return b;
};
const fakePdf = () => enc.encode("<html>%PDF-1.4</html>" + " ".repeat(20_000));

for (const honour of [true, false]) {
  test(`direct_api_html_as_pdf_refused_at_open (logic), Range ${honour ? "honoured" : "ignored"}`, async () => {
    const good = store(bigPdf(), honour);
    expect(await readAndSniff(good.fetcher, "application/pdf", 3_000_000)).toEqual({ ok: true, rangeHonoured: honour });
    // A PDF needs only its head: even when Range is ignored, it stops reading after about 8 KiB.
    expect(good.sent.bytes).toBeLessThan(20_000);
    const bad = store(fakePdf(), honour);
    expect((await readAndSniff(bad.fetcher, "application/pdf", fakePdf().length)).ok).toBe(false);
  });

  test(`Word: the zip directory is read from the end, Range ${honour ? "honoured" : "ignored"}`, async () => {
    const padding = Array.from({ length: 300 }, (_, i) => ({ name: `word/media/image${i}.png`, data: "p".repeat(5000) }));
    const zip = makeZip([...DOCX, ...padding]); // about 1.5 MB, directory at the end
    const ok = store(zip, honour);
    expect(await readAndSniff(ok.fetcher, W, zip.length)).toEqual({ ok: true, rangeHonoured: honour });
    expect(ok.sent.calls.length).toBe(honour ? 2 : 1);
    const macro = makeZip([...DOCX, ...padding, { name: "word/vbaProject.bin" }]);
    expect((await readAndSniff(store(macro, honour).fetcher, W, macro.length)).ok).toBe(false);
  });
}

test("a size that does not match the stored body, a missing object or a store error give false", async () => {
  const zip = makeZip(DOCX);
  expect((await readAndSniff(store(zip, false).fetcher, W, zip.length + 1)).ok).toBe(false);
  const missing: Fetcher = async () => new Response("not found", { status: 400 });
  expect(await readAndSniff(missing, "application/pdf", 10)).toEqual({ ok: false, rangeHonoured: null });
  const broken: Fetcher = async () => {
    throw new Error("timeout");
  };
  expect(await readAndSniff(broken, "application/pdf", 10)).toEqual({ ok: false, rangeHonoured: null });
});
