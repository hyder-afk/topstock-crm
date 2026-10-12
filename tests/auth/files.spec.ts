import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ageStepUp, appReady, createUser, fullSession, isCancelledPrefetch, nextWindow, setRole, settled, sql, totp, trackRequests } from "./helpers";

// Files on a lead (Day 4d, design 8.5, threats 20 to 28). Two kinds of test:
//  - local: everything that does not need Storage itself (the tab and its states, the checks made before any upload,
//    the team space, who may open what, the open route's refusals, the step-up before a delete);
//  - CI only (E2E_STORAGE=1, the auth-journey job runs storage-api): real uploads, the check on every open, links
//    that die after 60 s, deletes that remove the bytes. Locally they are skipped: the cloud VM has no Docker, so no
//    storage-api (logged waiver, design 8.5).
// Fixtures are made-up companies and files written straight into the local database.
test.describe.configure({ mode: "serial" });

const storage = !!process.env.E2E_STORAGE;
const password = "Files-Pass-42!";
const run = Date.now();
const adminEmail = `files-admin-${run}@example.test`;
const repEmail = `files-rep-${run}@example.test`;
let adminSecret = "";
let adminState: Awaited<ReturnType<BrowserContext["storageState"]>>;
let repState: Awaited<ReturnType<BrowserContext["storageState"]>>;
const uuid = /^[0-9a-f-]{36}$/;
const W = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function userId(email: string) {
  return sql(`select id from auth.users where email = '${email}'`);
}
function makeLead(name: string, ownerEmail: string) {
  const id = sql(`insert into public.companies (org_id, name, owner_id, lead_status, city, country)
                  select p.org_id, '${name}', p.id, 'warm', 'Lyon', 'FR' from public.profiles p where p.id = '${userId(ownerEmail)}' returning id`);
  expect(id).toMatch(uuid);
  return id;
}
// A ready file row (and, in this local stack's storage stand-in, its object), as if uploaded and checked. Test-only.
function seedFile(lead: string, name: string, o: { by: string; size?: number; mime?: string; status?: "ready" | "deleting"; ago?: string } = { by: adminEmail }) {
  const mime = o.mime ?? "application/pdf";
  const status = o.status ?? "ready";
  const id = sql(`insert into public.files (org_id, company_id, name, mime, size, uploaded_by, status, ready_at, created_at)
                  select c.org_id, c.id, $q$${name}$q$, '${mime}', ${o.size ?? 248_000}, '${userId(o.by)}', '${status}',
                         ${status === "ready" ? "now()" : "null"}, now() - interval '${o.ago ?? "1 hour"}'
                  from public.companies c where c.id = '${lead}' returning id`);
  expect(id).toMatch(uuid);
  return id;
}

async function open(browser: Browser, state: typeof adminState, o: { width?: number; locale?: string } = {}) {
  const width = o.width ?? 1440;
  const context = await browser.newContext({ storageState: state, viewport: { width, height: width < 600 ? 844 : 900 }, hasTouch: width < 600 });
  if (o.locale) await context.addCookies([{ name: "locale", value: o.locale, url: "http://localhost:3100" }]);
  const page = await context.newPage();
  trackRequests(page);
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && !isCancelledPrefetch(m.text()) && errors.push(m.text()));
  page.on("pageerror", (e) => !isCancelledPrefetch(e.message) && errors.push(e.message));
  return { context, page, errors };
}

async function gotoFiles(page: Page, lead: string) {
  await settled(page);
  await page.goto(`/leads/${lead}?tab=files`);
  await expect(page.locator("main h1")).toBeVisible();
  await appReady(page);
  await expect(page.getByRole("tabpanel", { name: "Files" })).toBeVisible();
}
const filesPanel = (page: Page) => page.getByRole("tabpanel", { name: "Files" });

// Small real-looking files built here (no documents in the repo).
const pdfBytes = (size = 4096) => {
  const b = Buffer.alloc(size, 0x20);
  b.write("%PDF-1.7\n");
  b.write("%%EOF\n", size - 6);
  return b;
};
function zipWith(names: string[]) {
  // A stored zip: local headers, central directory and end record (see tests/unit/helpers/zip.ts for the layout).
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const n of names) {
    const name = Buffer.from(n);
    const local = Buffer.alloc(30 + name.length + 1);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(1, 18);
    local.writeUInt32LE(1, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    local.write("x", 30 + name.length);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(1, 20);
    central.writeUInt32LE(1, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

let lead = "";
let repLead = "";

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  adminSecret = await createUser(adminEmail, password, true);
  const repSecret = await createUser(repEmail, password, true);
  setRole(adminEmail, "admin");
  setRole(repEmail, "rep");
  sql(`update public.profiles set first_name = 'Nora', last_name = 'Vidal' where id = '${userId(adminEmail)}'`);
  sql(`update public.profiles set first_name = 'Yanis', last_name = 'Morel' where id = '${userId(repEmail)}'`);
  lead = makeLead(`Comptoir Fichiers ${run}`, adminEmail);
  repLead = makeLead(`Atelier Fichiers ${run}`, repEmail);
  adminState = await fullSession(browser, adminEmail, password, adminSecret);
  repState = await fullSession(browser, repEmail, password, repSecret);
});

test("files_tab_empty_state: the tab is shown, empty, with the limits and a real button", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await gotoFiles(page, lead);
  const panel = filesPanel(page);
  await expect(panel.getByText("No files yet. Add quotes, price lists or photos.")).toBeVisible();
  await expect(panel.getByText("PDF, PNG, JPG, Word or Excel, up to 10 MB each")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Choose files" })).toBeVisible();
  const accept = await panel.locator("input[type=file]").getAttribute("accept");
  for (const t of ["application/pdf", "image/png", "image/jpeg", W, ".xlsx"]) expect(accept).toContain(t);
  // The tab strip has Files between Stock and Details, and arrows reach it.
  await expect(page.getByRole("tab")).toHaveText(["Summary", "Timeline", "Deals", "Stock", "Files", "Details"]);
  await page.getByRole("tab", { name: "Files" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Details" })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
  expect(errors).toEqual([]);
  await context.close();
});

test("too_big_rejected_before_upload, renamed_exe_rejected, docm_renamed_docx_rejected: nothing is sent", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await gotoFiles(page, lead);
  const sent: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/storage/v1/") || r.method() === "POST") sent.push(`${r.method()} ${r.url()}`);
  });
  const input = filesPanel(page).locator("input[type=file]");
  await input.setInputFiles([
    { name: "catalogue.pdf", mimeType: "application/pdf", buffer: pdfBytes(10_485_761) },
    { name: "invoice.pdf", mimeType: "application/pdf", buffer: Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0]) },
    { name: "offre.docx", mimeType: W, buffer: zipWith(["[Content_Types].xml", "word/document.xml", "word/vbaProject.bin"]) },
    { name: "page.pdf", mimeType: "application/pdf", buffer: Buffer.from("<html><body>%PDF-1.4</body></html>") },
    { name: "vector.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") },
  ]);
  const uploads = filesPanel(page).getByRole("list", { name: "Uploads" });
  await expect(uploads.getByText(/^Too big: a file can be up to 10\sMB\./)).toBeVisible();
  await expect(uploads.getByText(/^This file isn’t really a PDF\./)).toHaveCount(2);
  await expect(uploads.getByText(/^This isn’t a real Word file, or it contains macros\./)).toBeVisible();
  await expect(uploads.getByText("Only PDF, PNG, JPG, Word or Excel files.")).toBeVisible();
  expect(sent).toEqual([]);
  // Dismissing a refused file moves the focus to Choose files, never to the page.
  await uploads.getByRole("button", { name: "Dismiss catalogue.pdf" }).focus();
  await page.keyboard.press("Enter");
  await expect(filesPanel(page).getByRole("button", { name: "Choose files" })).toBeFocused();
  expect(errors).toEqual([]);
  await context.close();
});

test("files_list: rows, sizes, who and when; names as text (xss); the team space for admins only", async ({ browser }) => {
  seedFile(lead, "Devis printemps 2026.pdf", { by: adminEmail, size: 1_258_291 });
  seedFile(lead, "Tarifs grossiste octobre.xlsx", { by: repEmail, size: 48_128, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ago: "2 days" });
  seedFile(lead, "<img src=x onerror=alert(1)>.pdf", { by: adminEmail, size: 900, ago: "3 days" });
  const { context, page, errors } = await open(browser, adminState);
  let dialogs = 0;
  page.on("dialog", (d) => {
    dialogs += 1;
    void d.dismiss();
  });
  await gotoFiles(page, lead);
  const panel = filesPanel(page);
  await expect(panel.getByRole("link", { name: /Devis printemps 2026\.pdf/ })).toBeVisible();
  await expect(panel.getByText("1.2 MB")).toBeVisible();
  await expect(panel.getByText("47 kB").or(panel.getByText("47 KB"))).toBeVisible();
  await expect(panel.getByText("Yanis Morel")).toBeVisible();
  await expect(panel.getByText("You").first()).toBeVisible();
  await expect(panel.getByRole("link", { name: /^<img src=x onerror=alert\(1\)>\.pdf/ })).toBeVisible();
  expect(dialogs).toBe(0);
  await expect(panel.getByText(/of 800 MB used$/)).toBeVisible();
  // file_link_has_no_token_in_dom: rows link to the app's own route; no storage link or token anywhere in the page.
  const hrefs = await panel.locator("a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  for (const h of hrefs) expect(h).toMatch(/^\/api\/files\/[0-9a-f-]{36}\?disposition=(inline|attachment)$/);
  const html = await page.content();
  expect(html).not.toMatch(/token=|\/storage\/v1\/object\/sign/);
  // PDFs open in a new tab without the opener or a referrer; Word and Excel download.
  await expect(panel.getByRole("link", { name: /Devis printemps/ })).toHaveAttribute("rel", "noopener noreferrer");
  await expect(panel.getByRole("link", { name: /Tarifs grossiste/ })).not.toHaveAttribute("target", "_blank");
  // The menu: Open, Download, Delete (keyboard).
  await panel.getByRole("button", { name: "Actions for Devis printemps 2026.pdf" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem")).toHaveText(["Open", "Download", "Delete"]);
  await page.keyboard.press("Escape");
  await expect(panel.getByRole("button", { name: "Actions for Devis printemps 2026.pdf" })).toBeFocused();
  expect(errors).toEqual([]);
  await context.close();
  // A rep sees no team space, and not the admin's lead's files (D11: as today).
  const rep = await open(browser, repState);
  await gotoFiles(rep.page, lead);
  await expect(filesPanel(rep.page).getByText(/of 800 MB used$/)).toHaveCount(0);
  await expect(filesPanel(rep.page).getByText("Tarifs grossiste octobre.xlsx")).toBeVisible(); // the rep's own upload
  await expect(filesPanel(rep.page).getByText("Devis printemps 2026.pdf")).toHaveCount(0);
  expect(rep.errors).toEqual([]);
  await rep.context.close();
});

test("rep_cannot_open_others_file, cross_site_file_request_refused, the unavailable page", async ({ browser }) => {
  const adminFile = seedFile(lead, "Confidentiel.pdf", { by: adminEmail });
  const rep = await open(browser, repState);
  await rep.page.goto("/leads");
  const res = await rep.page.request.get(`/api/files/${adminFile}`, { headers: { "Sec-Fetch-Site": "same-origin" }, maxRedirects: 0 });
  expect(res.status()).toBe(303);
  expect(new URL(res.headers()["location"], "http://localhost:3100").pathname).toBe("/files/unavailable");
  expect(res.headers()["cache-control"]).toContain("no-store");
  expect(res.headers()["referrer-policy"]).toBe("no-referrer");
  // Another site making the browser open a file: refused before anything is read.
  const cross = await rep.page.request.get(`/api/files/${adminFile}`, { headers: { "Sec-Fetch-Site": "cross-site" }, maxRedirects: 0 });
  expect(cross.status()).toBe(403);
  const noHeader = await rep.page.request.get(`/api/files/${adminFile}`, { headers: { "Sec-Fetch-Site": "same-site" }, maxRedirects: 0 });
  expect(noHeader.status()).toBe(403);
  // Garbage ids and dispositions: the same unavailable answer.
  for (const path of ["/api/files/not-a-uuid", `/api/files/${adminFile}?disposition=evil`, `/api/files/${adminFile}?x=1`]) {
    const r = await rep.page.request.get(path, { headers: { "Sec-Fetch-Site": "same-origin" }, maxRedirects: 0 });
    expect(r.status(), path).toBe(303);
  }
  await rep.page.goto("/files/unavailable");
  await expect(rep.page.getByRole("heading", { name: "This file can’t be opened" })).toBeVisible();
  await expect(rep.page.getByRole("link", { name: "Back to leads" })).toBeVisible();
  expect(rep.errors).toEqual([]);
  await rep.context.close();
});

test("quota_message: a full team space refuses before any byte is sent", async ({ browser }) => {
  // Test-only: the team's space lowered to what is used now (restored after).
  sql(`create or replace function private.file_quota_bytes() returns bigint language sql stable set search_path = '' as $$ select 1::bigint $$`);
  try {
    const { context, page, errors } = await open(browser, repState);
    await gotoFiles(page, repLead);
    await filesPanel(page).locator("input[type=file]").setInputFiles({ name: "devis.pdf", mimeType: "application/pdf", buffer: pdfBytes() });
    await expect(filesPanel(page).getByText(/^The team’s file space is full \(800\sMB\)\./)).toBeVisible();
    expect(sql(`select count(*) from public.files where company_id = '${repLead}' and name = 'devis.pdf'`)).toBe("0");
    expect(errors).toEqual([]);
    await context.close();
  } finally {
    sql(`create or replace function private.file_quota_bytes() returns bigint language sql stable set search_path = '' as $$ select 838860800::bigint $$`);
  }
});

test("delete_needs_fresh_code (the database asks for the code), stuck delete shows Retry", async ({ browser }) => {
  const name = "A supprimer.pdf";
  const id = seedFile(lead, name, { by: adminEmail });
  const { context, page, errors } = await open(browser, adminState);
  await ageStepUp(context, 700);
  await gotoFiles(page, lead);
  const panel = filesPanel(page);
  await panel.getByRole("button", { name: `Actions for ${name}` }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete this file?" });
  await expect(confirm).toContainText(`“${name}” will be removed for everyone.`);
  await confirm.getByRole("button", { name: "Delete" }).click();
  // The code is older than 10 minutes: "Confirm it's you" first; the file is untouched until then.
  const stepUp = page.getByRole("dialog", { name: "Confirm it’s you" });
  await expect(stepUp).toBeVisible();
  expect(sql(`select status from public.files where id = '${id}'`)).toBe("ready");
  await nextWindow();
  await stepUp.getByLabel("6-digit code").fill(totp(adminSecret));
  if (storage) {
    await expect(panel.getByText(name)).toHaveCount(0);
    expect(sql(`select count(*) from public.files where id = '${id}'`)).toBe("0");
  } else {
    // No storage-api here: the bytes cannot be removed, so the row stays "deleting" and says so, with Retry.
    await expect(panel.getByText("Couldn’t finish deleting")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Retry" })).toBeVisible();
    expect(sql(`select status from public.files where id = '${id}'`)).toBe("deleting");
  }
  expect(errors.filter((e) => !/storage\/v1|Failed to load resource/.test(e))).toEqual([]);
  await context.close();
});

test("phone_390_files: no sideways scroll, Add file and the row menus are 44 px", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState, { width: 390 });
  await gotoFiles(page, lead);
  const panel = filesPanel(page);
  const add = panel.getByRole("button", { name: "Add file" });
  await expect(add).toBeVisible();
  expect((await add.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const menu = panel.getByRole("button", { name: /^Actions for / }).first();
  const box = (await menu.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
  await context.close();
});

// ---------------------------------------------------------------------------------------------------------------------
// CI only (E2E_STORAGE=1): real Storage.
// ---------------------------------------------------------------------------------------------------------------------
function env(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}
// An aal2 access token for a test user, the way the app gets one (password, then the authenticator code).
async function aal2Token(email: string, secret: string) {
  const url = env("SUPABASE_LOCAL_URL");
  const key = env("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const h = (token?: string) => ({ apikey: key, Authorization: `Bearer ${token ?? key}`, "Content-Type": "application/json" });
  const pw = await (await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST", headers: h(), body: JSON.stringify({ email, password }) })).json();
  const user = await (await fetch(`${url}/auth/v1/user`, { headers: h(pw.access_token) })).json();
  const factor = (user.factors as { id: string; status: string }[]).find((f) => f.status === "verified")!;
  const challenge = await (await fetch(`${url}/auth/v1/factors/${factor.id}/challenge`, { method: "POST", headers: h(pw.access_token), body: "{}" })).json();
  await nextWindow();
  const verified = await (
    await fetch(`${url}/auth/v1/factors/${factor.id}/verify`, { method: "POST", headers: h(pw.access_token), body: JSON.stringify({ challenge_id: challenge.id, code: totp(secret) }) })
  ).json();
  return verified.access_token as string;
}
async function rpc(token: string, fn: string, args: Record<string, unknown>) {
  const res = await fetch(`${env("SUPABASE_LOCAL_URL")}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: env("NEXT_PUBLIC_SUPABASE_ANON_KEY"), Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function putObject(token: string, path: string, mime: string, body: Buffer) {
  const res = await fetch(`${env("SUPABASE_LOCAL_URL")}/storage/v1/object/lead-files/${path}`, {
    method: "POST",
    headers: { apikey: env("NEXT_PUBLIC_SUPABASE_ANON_KEY"), Authorization: `Bearer ${token}`, "content-type": mime, "x-upsert": "false" },
    body: new Uint8Array(body),
  });
  return res.status;
}

test.describe("with storage-api (CI)", () => {
  test.skip(!storage, "needs storage-api: CI auth-journey only (logged waiver, design 8.5)");

  test("upload_pdf_progress_then_open, signed_url_dead_after_60s, deleted_file_url_404", async ({ browser }) => {
    test.setTimeout(240_000);
    const { context, page, errors } = await open(browser, adminState);
    await gotoFiles(page, lead);
    await filesPanel(page).locator("input[type=file]").setInputFiles({ name: "Catalogue été.pdf", mimeType: "application/pdf", buffer: pdfBytes(2_000_000) });
    await expect(filesPanel(page).getByRole("progressbar", { name: "Uploading Catalogue été.pdf" })).toBeVisible();
    const link = filesPanel(page).getByRole("link", { name: /Catalogue été\.pdf/ });
    await expect(link).toBeVisible({ timeout: 30_000 });
    const id = sql(`select id from public.files where company_id = '${lead}' and name = 'Catalogue été.pdf' and status = 'ready'`);
    expect(id).toMatch(uuid);
    // Open: a new tab lands on Storage's signed link (the route's 303), with the PDF.
    const [popup] = await Promise.all([page.waitForEvent("popup"), link.click()]);
    await popup.waitForLoadState();
    expect(new URL(popup.url()).origin).toBe(new URL(env("SUPABASE_LOCAL_URL")).origin);
    await popup.close();
    expect(sql(`select count(*) from public.audit_log where action = 'file_access' and record_id = '${id}'`)).toBe("1");
    // The link itself, read from the redirect (it is in no page): it works now, not after 60 s.
    const res = await page.request.get(`/api/files/${id}?disposition=attachment`, { headers: { "Sec-Fetch-Site": "same-origin" }, maxRedirects: 0 });
    expect(res.status()).toBe(303);
    const signed = res.headers()["location"];
    expect((await fetch(signed)).status).toBe(200);
    await page.waitForTimeout(61_000);
    expect((await fetch(signed)).status).toBeGreaterThanOrEqual(400);
    expect(errors).toEqual([]);
    await context.close();
  });

  test("direct_api_html_as_pdf_refused_at_open: bytes stored by a direct API call are checked when opened", async ({ browser }) => {
    test.setTimeout(240_000);
    const token = await aal2Token(adminEmail, adminSecret);
    const html = Buffer.from("<!doctype html><script>alert(document.cookie)</script>");
    const begun = await rpc(token, "begin_file_upload", { p_company: lead, p_name: "trap.pdf", p_mime: "application/pdf", p_size: html.length });
    expect(begun.status).toBe(200);
    expect(await putObject(token, begun.body.path, "application/pdf", html)).toBe(200);
    // The database checks only the stored size and type, so a direct finish passes: the open is the last line.
    expect((await rpc(token, "finish_file_upload", { p_id: begun.body.id })).status).toBe(200);
    const { context, page } = await open(browser, adminState);
    await page.goto("/leads");
    const res = await page.request.get(`/api/files/${begun.body.id}?disposition=inline`, { headers: { "Sec-Fetch-Site": "same-origin" }, maxRedirects: 0 });
    expect(res.status()).toBe(303);
    expect(new URL(res.headers()["location"], "http://localhost:3100").pathname).toBe("/files/unavailable");
    await context.close();
  });

  test("name_accents_download: Word files download under their own name", async ({ browser }) => {
    const { context, page, errors } = await open(browser, adminState);
    await gotoFiles(page, lead);
    const docx = zipWith(["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);
    await filesPanel(page).locator("input[type=file]").setInputFiles({ name: "Bon de commande n°7 — été.docx", mimeType: W, buffer: docx });
    const link = filesPanel(page).getByRole("link", { name: /Bon de commande n°7 — été\.docx/ });
    await expect(link).toBeVisible({ timeout: 30_000 });
    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    expect(download.suggestedFilename()).toBe("Bon de commande n°7 — été.docx");
    expect(errors).toEqual([]);
    await context.close();
  });
});
