import { expect, test } from "@playwright/test";
import { withDownloadName } from "@/lib/files/link";

// What Storage reads back is the query decoded once (URLSearchParams), so the name must survive exactly that.
const base = new URL("https://project.supabase.co/storage/v1/object/sign/lead-files/org/id?token=abc.def.ghi");
const names = [
  "Bon de commande n°7 — été.docx",
  "Facture 2026 (copie) 'final'.pdf",
  "100% + 50% & co #3.xlsx",
  "naïve café ½ – Œuvre.docx",
  "a%20b %C2%B0.pdf",
  'devis "spécial".pdf',
];

test("download_name_round_trips: Storage decodes the exact file name", () => {
  for (const name of names) {
    const url = withDownloadName(base, name);
    expect(url.searchParams.get("download")).toBe(name);
    expect(url.searchParams.get("token")).toBe("abc.def.ghi");
    expect(url.origin + url.pathname).toBe(base.origin + base.pathname);
  }
});

test("download_name_replaces: a download parameter already on the link is replaced, not repeated", () => {
  const url = withDownloadName(new URL(`${base}&download=old.pdf`), "new é.pdf");
  expect(url.searchParams.getAll("download")).toEqual(["new é.pdf"]);
});

test("storage_js_double_encodes: the storage-js way (URLSearchParams then encodeURI) does not round-trip", () => {
  // storage-js 2.117.3 createSignedUrl: encodeURI(`${url}${signedURL}&${new URLSearchParams({ download })}`).
  const name = "Bon de commande n°7 — été.docx";
  const theirs = new URL(encodeURI(`${base}&${new URLSearchParams({ download: name })}`));
  expect(theirs.searchParams.get("download")).toBe("Bon de commande n%C2%B07 %E2%80%94 %C3%A9t%C3%A9.docx");
  expect(theirs.searchParams.get("download")).not.toBe(name);
});

test("no_name_no_change: the link is not mutated in place", () => {
  const link = new URL(base);
  withDownloadName(link, "x.pdf");
  expect(link.searchParams.has("download")).toBe(false);
});
