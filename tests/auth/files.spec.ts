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
// A ready file row and its object row (no bytes), as if uploaded and checked. Test-only.
function seedFile(lead: string, name: string, o: { by: string; size?: number; mime?: string; status?: "ready" | "deleting"; ago?: string } = { by: adminEmail }) {
  const mime = o.mime ?? "application/pdf";
  const status = o.status ?? "ready";
  const id = sql(`insert into public.files (org_id, company_id, name, mime, size, uploaded_by, status, ready_at, created_at)
                  select c.org_id, c.id, $q$${name}$q$, '${mime}', ${o.size ?? 248_000}, '${userId(o.by)}', '${status}',
                         ${status === "ready" ? "now()" : "null"}, now() - interval '${o.ago ?? "1 hour"}'
                  from public.companies c where c.id = '${lead}' returning id`);
  expect(id).toMatch(uuid);
  // open_file serves a ready file only while its stored object is the one checked at finish (same version, size and
  // type): the stand-in object row has the row's size and type, and no version on either side. Where the real
  // storage-api refuses a direct insert (CI), the row stays without an object, and opening it answers "not found".
  if (status === "ready") {
    sql(`do $$ begin
           insert into storage.objects (bucket_id, name, metadata)
           select 'lead-files', f.storage_path, jsonb_build_object('size', f.size, 'mimetype', f.mime) from public.files f where f.id = '${id}';
         exception when others then null;
         end $$`);
  }
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
  await expect(panel.getByText("1.2 MB", { exact: true })).toBeVisible(); // exact: the team space can read "1.2 MB of 800 MB used" on a fresh stack
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

const accesses = (file: string) => sql(`select count(*) from public.audit_log where action = 'file_access' and record_id = '${file}'`);

test("rep_cannot_open_others_file, cross_site_file_request_refused, the unavailable page", async ({ browser }) => {
  const adminFile = seedFile(lead, "Confidentiel.pdf", { by: adminEmail });
  const rep = await open(browser, repState);
  await rep.page.goto("/leads");
  const res = await rep.page.request.get(`/api/files/${adminFile}`, { headers: { "Sec-Fetch-Site": "same-origin" }, maxRedirects: 0 });
  expect(res.status()).toBe(303);
  expect(new URL(res.headers()["location"], "http://localhost:3100").pathname).toBe("/files/unavailable");
  expect(res.headers()["cache-control"]).toContain("no-store");
  expect(res.headers()["referrer-policy"]).toBe("no-referrer");
  // Without bytes here every open ends on /files/unavailable, so the answer alone proves nothing (verifier 4d finding
  // 2). open_file writes the file_access audit row only when the caller may open the file: none for the rep, one for
  // the admin (the control: the same request reaches open_file). Real bytes: the CI test below.
  expect(accesses(adminFile)).toBe("0");
  const admin = await open(browser, adminState);
  await admin.page.goto("/leads");
  const own = await admin.page.request.get(`/api/files/${adminFile}`, { headers: { "Sec-Fetch-Site": "same-origin" }, maxRedirects: 0 });
  expect(own.status()).toBe(303);
  expect(accesses(adminFile)).toBe("1");
  await admin.context.close();
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
    // The delete failed after the code (bytes not removed): the row's menu is gone, so the focus goes to its Retry,
    // never to the page (verifier 4d round 3 finding 1).
    await expect(panel.getByRole("button", { name: `Retry deleting ${name}` })).toBeFocused();
    // Retry names its file and keeps the focus through a retry that fails again (aria-disabled while busy, never
    // disabled, so the focus does not drop to the page; verifier 4d round 2 finding 11).
    const retry = panel.getByRole("button", { name: `Retry deleting ${name}` });
    await expect(retry).toHaveText("Retry");
    expect(sql(`select status from public.files where id = '${id}'`)).toBe("deleting");
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Couldn’t finish deleting. Try again.")).toBeVisible();
    await expect(retry).toBeFocused();
    await expect(retry).not.toHaveAttribute("aria-disabled", "true");
  }
  expect(errors.filter((e) => !/storage\/v1|Failed to load resource/.test(e))).toEqual([]);
  await context.close();
});

test("delete dialog focus: Escape, Cancel, a failed delete and a cancelled code give it back to the row's Actions, never the page (round 3 finding 1)", async ({ browser }) => {
  const name = `Focus retour ${run}.pdf`;
  const id = seedFile(lead, name, { by: adminEmail });
  // A session of its own, signed in with a code just now (no "Confirm it's you" before the failed delete below), whose
  // refresh token ageStepUp can use later (the shared admin state's was used by the test above).
  const state = await fullSession(browser, adminEmail, password, adminSecret);
  const { context, page, errors } = await open(browser, state);
  let failDelete = false;
  await page.route(
    (url) => url.pathname === `/leads/${lead}`,
    async (route) => (failDelete && route.request().method() === "POST" && route.request().headers()["next-action"] ? route.abort("failed") : route.fallback()),
  );
  await gotoFiles(page, lead);
  const panel = filesPanel(page);
  const actions = panel.getByRole("button", { name: `Actions for ${name}` });
  const confirm = page.getByRole("dialog", { name: "Delete this file?" });
  const chooseDelete = async () => {
    await actions.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("End");
    await expect(page.getByRole("menuitem", { name: "Delete" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  };
  // Escape.
  await chooseDelete();
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(actions).toBeFocused();
  // Cancel.
  await chooseDelete();
  await page.keyboard.press("Enter");
  await expect(confirm).toHaveCount(0);
  await expect(actions).toBeFocused();
  // Delete, and the call fails (connection lost): a toast, the file kept, the focus on its Actions.
  await chooseDelete();
  failDelete = true;
  await confirm.getByRole("button", { name: "Delete" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Couldn’t finish deleting. Try again.")).toBeVisible();
  await expect(actions).toBeFocused();
  failDelete = false;
  expect(sql(`select status from public.files where id = '${id}'`)).toBe("ready");
  // A code older than 10 minutes: Delete asks for a new one; cancelling it gives the focus back to the row too.
  await ageStepUp(context, 700);
  await gotoFiles(page, lead);
  await chooseDelete();
  await confirm.getByRole("button", { name: "Delete" }).focus();
  await page.keyboard.press("Enter");
  const stepUp = page.getByRole("dialog", { name: "Confirm it’s you" });
  await expect(stepUp.getByLabel("6-digit code")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(stepUp).toHaveCount(0);
  await expect(actions).toBeFocused();
  expect(sql(`select status from public.files where id = '${id}'`)).toBe("ready");
  expect(errors.filter((e) => !/Failed to fetch|Failed to load resource|net::ERR_FAILED/.test(e))).toEqual([]);
  await context.close();
});

test("phone_390_files: no sideways scroll; Add file, the row menus, the row's open target and Retry are 44 px", async ({ browser }) => {
  const stuck = `Ancienne fiche ${run}.pdf`;
  seedFile(lead, stuck, { by: adminEmail, status: "deleting", ago: "30 days" });
  const { context, page, errors } = await open(browser, adminState, { width: 390 });
  await gotoFiles(page, lead);
  const panel = filesPanel(page);
  // The name's link covers its whole line on phones (verifier 4d round 2 finding 16): a tap on the icon tile or the
  // meta line (size, who, when) lands on the link, and that line is at least 44 px tall.
  const link = panel.getByRole("link", { name: /Devis printemps 2026\.pdf/ });
  const hit = await link.evaluate((a) => {
    const row = a.closest("li")!.firstElementChild as HTMLElement;
    row.scrollIntoView({ block: "center" }); // in the viewport and clear of the dock, for elementFromPoint
    const r = row.getBoundingClientRect();
    const meta = row.querySelector("p")!.getBoundingClientRect();
    const at = (x: number, y: number) => document.elementFromPoint(x, y)?.closest("a") === a;
    return { height: r.height, icon: at(r.left + 12, r.top + r.height / 2), meta: at(meta.left + 8, meta.top + meta.height / 2) };
  });
  expect(hit.height).toBeGreaterThanOrEqual(44);
  expect(hit.icon).toBe(true);
  expect(hit.meta).toBe(true);
  // The stuck delete's Retry: 44 by 44 in English (a short word).
  const retry = (await panel.getByRole("button", { name: `Retry deleting ${stuck}` }).boundingBox())!;
  expect(retry.height).toBeGreaterThanOrEqual(44);
  expect(retry.width).toBeGreaterThanOrEqual(44);
  const add = panel.getByRole("button", { name: "Add file" });
  await expect(add).toBeVisible();
  expect((await add.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const menu = panel.getByRole("button", { name: /^Actions for / }).first();
  const box = (await menu.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  // A deep link to the Files tab scrolls the tab strip (not the page) so the selected tab is whole on screen.
  const tab = (await page.getByRole("tab", { name: "Files" }).boundingBox())!;
  const strip = (await page.getByRole("tablist").boundingBox())!;
  expect(tab.x).toBeGreaterThanOrEqual(strip.x);
  expect(tab.x + tab.width).toBeLessThanOrEqual(strip.x + strip.width + 0.5);
  expect(errors).toEqual([]);
  await context.close();
});

// ---------------------------------------------------------------------------------------------------------------------
// Uploads without storage-api: the Storage request and the finish are held or answered by the test (page.route), so
// each state of a line can be reached and checked here (verifier 4d round 2 findings 7, 8, 10, 13, 14, 17, 18).
// ---------------------------------------------------------------------------------------------------------------------
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}
const said = (page: Page) => filesPanel(page).locator("[role=status] p").allTextContents();

test("announcements: each refusal says why, and files past 5 are announced once (finding 14)", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await gotoFiles(page, lead);
  const svg = (n: number) => ({ name: `plan ${n}.svg`, mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") });
  await filesPanel(page)
    .locator("input[type=file]")
    .setInputFiles([
      { name: "facture.pdf", mimeType: "application/pdf", buffer: Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]) },
      svg(1),
      svg(2),
      svg(3),
      svg(4),
      { name: "en trop 1.pdf", mimeType: "application/pdf", buffer: pdfBytes() },
      { name: "en trop 2.pdf", mimeType: "application/pdf", buffer: pdfBytes() },
    ]);
  const uploads = filesPanel(page).getByRole("list", { name: "Uploads" });
  await expect(uploads.locator("li")).toHaveCount(7);
  await expect.poll(() => said(page)).toHaveLength(6);
  const messages = await said(page);
  expect(messages[0]).toBe("2 files weren’t added: up to 5 at a time.");
  expect(messages).toContain("facture.pdf wasn’t added. This file isn’t really a PDF. Save or export it as a PDF again, then add it.");
  for (let n = 1; n <= 4; n++) expect(messages).toContain(`plan ${n}.svg wasn’t added. Only PDF, PNG, JPG, Word or Excel files.`);
  // The extra files can be tried again from their own line; a refused file cannot (it has to change first).
  await expect(uploads.getByRole("button", { name: "Try en trop 1.pdf again" })).toBeVisible();
  await expect(uploads.getByRole("button", { name: "Try facture.pdf again" })).toHaveCount(0);
  expect(errors).toEqual([]);
  await context.close();
});

test("upload line focus: Cancel -> the line while checking -> Try again -> Cancel -> Choose files; a failed check cancels the pending row (findings 7, 8, 13)", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await gotoFiles(page, lead);
  const name = `Devis focus ${run}.pdf`;
  let storage = gate();
  let storageDone = false;
  let mode: "ok" | "fail" | "hold" = "ok";
  await page.route("**/storage/v1/object/lead-files/**", async (route) => {
    await storage.opened;
    try {
      if (mode === "fail") return await route.abort("failed");
      storageDone = true;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ Key: "lead-files/x", Id: "x" }) });
    } catch {
      // the browser cancelled the request first (Cancel)
    }
  });
  const finish = gate();
  let finishHeld = false;
  await page.route(
    (url) => url.pathname === `/leads/${lead}`,
    async (route) => {
      const r = route.request();
      if (r.method() === "POST" && r.headers()["next-action"] && storageDone && !finishHeld) {
        finishHeld = true;
        await finish.opened;
      }
      await route.fallback();
    },
  );
  const panel = filesPanel(page);
  const line = panel.locator("[data-upload-key]");
  await panel.locator("input[type=file]").setInputFiles({ name, mimeType: "application/pdf", buffer: pdfBytes(64_000) });
  const cancel = line.getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeVisible();
  await cancel.focus();
  // The bytes arrive: Cancel goes, the focus moves to the line (never to the page).
  storage.open();
  await expect(line.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "Checking the file…");
  await expect(line).toBeFocused();
  expect(sql(`select count(*) from public.files where company_id = '${lead}' and name = $q$${name}$q$ and status = 'pending'`)).toBe("1");
  // The check cannot read the bytes here (no storage-api): the line says so, Try again takes the focus, and the
  // pending row is cancelled at once instead of waiting 15 minutes unseen.
  finish.open();
  await expect(line).toContainText("Couldn’t add this file. Try again.");
  const again = line.getByRole("button", { name: `Try ${name} again` });
  await expect(again).toBeFocused();
  await expect.poll(() => sql(`select count(*) from public.files where company_id = '${lead}' and name = $q$${name}$q$ and status = 'pending'`)).toBe("0");
  expect(await said(page)).toContain(`${name} wasn’t added. Couldn’t add this file. Try again.`);
  // Try again: the same line uploads again and its Cancel takes the focus; Cancel then ends on Choose files.
  storage = gate();
  mode = "hold";
  await page.keyboard.press("Enter");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel.getByRole("button", { name: "Choose files" })).toBeFocused();
  await expect(line).toHaveCount(0);
  storage.open();
  // A connection lost while sending: Cancel goes, Try again takes the focus.
  storage = gate();
  mode = "fail";
  await panel.locator("input[type=file]").setInputFiles({ name, mimeType: "application/pdf", buffer: pdfBytes(64_000) });
  await expect(cancel).toBeVisible();
  await cancel.focus();
  storage.open();
  await expect(line).toContainText("Connection lost. Try again.");
  await expect(again).toBeFocused();
  await expect.poll(() => sql(`select count(*) from public.files where company_id = '${lead}' and name = $q$${name}$q$ and status = 'pending'`)).toBe("0");
  expect(errors.filter((e) => !/storage\/v1|Failed to load resource|net::ERR_FAILED/.test(e))).toEqual([]);
  await context.close();
});

test("hidden tab: an outcome shows as a toast and the line waits; a file dropped outside the zone never leaves the page (findings 17, 18)", async ({ browser }) => {
  const { context, page, errors } = await open(browser, adminState);
  await gotoFiles(page, lead);
  const name = `Tarif caché ${run}.pdf`;
  const storage = gate();
  await page.route("**/storage/v1/object/lead-files/**", async (route) => {
    await storage.opened;
    await route.abort("failed").catch(() => null);
  });
  // Dropped files: refused everywhere but the zone while Files is shown; untouched while another tab is shown.
  const dropped = (selector: string) =>
    page.evaluate((sel) => {
      const dt = new DataTransfer();
      dt.items.add(new File(["%PDF-1.7"], "x.pdf", { type: "application/pdf" }));
      const target = document.querySelector(sel)!;
      const out: Record<string, boolean> = {};
      for (const type of ["dragover", "drop"]) {
        const e = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
        target.dispatchEvent(e);
        out[type] = e.defaultPrevented;
      }
      return out;
    }, selector);
  expect(await dropped("main h1")).toEqual({ dragover: true, drop: true });
  expect(await dropped("section:has(input[type=file]) h2")).toEqual({ dragover: true, drop: true });
  await filesPanel(page).locator("input[type=file]").setInputFiles({ name, mimeType: "application/pdf", buffer: pdfBytes(64_000) });
  await expect(filesPanel(page).getByRole("button", { name: "Cancel" })).toBeVisible();
  await page.getByRole("tab", { name: "Timeline" }).click();
  await expect(page.getByRole("tabpanel", { name: "Timeline" })).toBeVisible();
  expect(await dropped("main h1")).toEqual({ dragover: false, drop: false });
  storage.open();
  await expect(page.getByText(`${name} wasn’t added. Connection lost. Try again.`).filter({ visible: true })).toBeVisible(); // the toast (the tab’s own status line is hidden with the tab)
  await page.getByRole("tab", { name: "Files" }).click();
  await expect(filesPanel(page).locator("[data-upload-key]")).toContainText("Connection lost. Try again.");
  expect(errors.filter((e) => !/storage\/v1|Failed to load resource|net::ERR_FAILED/.test(e))).toEqual([]);
  await context.close();
});

test("show older files: a failed page says so and keeps the focus; the last page moves the focus to its first file (finding 10)", async ({ browser }) => {
  const many = makeLead(`Grossiste Archives ${run}`, adminEmail);
  sql(`insert into public.files (org_id, company_id, name, mime, size, uploaded_by, status, ready_at, created_at)
       select c.org_id, c.id, format('Lot %s.pdf', lpad(g::text, 2, '0')), 'application/pdf', 1000 + g, '${userId(adminEmail)}', 'ready', now(),
              now() - make_interval(mins => g)
       from public.companies c, generate_series(1, 52) g where c.id = '${many}'`);
  const { context, page, errors } = await open(browser, adminState);
  let failing = true;
  await page.route(
    (url) => url.pathname === `/api/leads/${many}/files` && url.searchParams.has("before_at"),
    async (route) => (failing ? route.fulfill({ status: 502, body: "" }) : route.fallback()),
  );
  await gotoFiles(page, many);
  const panel = filesPanel(page);
  await expect(panel.getByRole("link", { name: /^Lot 50\.pdf/ })).toBeVisible();
  const more = panel.getByRole("button", { name: "Show older files" });
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(panel.getByRole("alert")).toHaveText("Couldn’t load older files.");
  const tryAgain = panel.getByRole("button", { name: "Try again" });
  await expect(tryAgain).toBeFocused();
  failing = false;
  await page.keyboard.press("Enter");
  await expect(panel.getByRole("link", { name: /^Lot 52\.pdf/ })).toBeVisible();
  await expect(tryAgain).toHaveCount(0);
  await expect(panel.getByRole("link", { name: /^Lot 51\.pdf/ })).toBeFocused();
  expect(errors.filter((e) => !/502|Failed to load resource/.test(e))).toEqual([]);
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
    test.setTimeout(300_000);
    const { context, page, errors } = await open(browser, adminState);
    await gotoFiles(page, lead);
    await filesPanel(page).locator("input[type=file]").setInputFiles({ name: "Catalogue été.pdf", mimeType: "application/pdf", buffer: pdfBytes(2_000_000) });
    const progress = filesPanel(page).getByRole("progressbar", { name: "Uploading Catalogue été.pdf" });
    await expect(progress).toBeVisible();
    // The value is read out in the page's language (Intl percent: "40%" in English), or "Checking the file…" after.
    await expect(progress).toHaveAttribute("aria-valuetext", /^(\d{1,3}%|Checking the file…)$/);
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
    // deleted_file_url_404 (design threat 22; verifier 4d finding 3): a link handed out before the delete dies with it,
    // the stored object is gone, and the app's route answers "unavailable".
    const path = sql(`select storage_path from public.files where id = '${id}'`);
    const before = await page.request.get(`/api/files/${id}?disposition=attachment`, { headers: { "Sec-Fetch-Site": "same-origin" }, maxRedirects: 0 });
    const fresh = before.headers()["location"];
    expect((await fetch(fresh)).status).toBe(200);
    expect(sql(`select count(*) from storage.objects where bucket_id = 'lead-files' and name = '${path}'`)).toBe("1");
    await ageStepUp(context, 700);
    await gotoFiles(page, lead); // the page reads the aged session
    await filesPanel(page).getByRole("button", { name: "Actions for Catalogue été.pdf" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("dialog", { name: "Delete this file?" }).getByRole("button", { name: "Delete" }).click();
    const stepUp = page.getByRole("dialog", { name: "Confirm it’s you" });
    await expect(stepUp).toBeVisible();
    await nextWindow();
    await stepUp.getByLabel("6-digit code").fill(totp(adminSecret));
    await expect(filesPanel(page).getByText("Catalogue été.pdf")).toHaveCount(0);
    expect(sql(`select count(*) from public.files where id = '${id}'`)).toBe("0");
    expect(sql(`select count(*) from storage.objects where bucket_id = 'lead-files' and name = '${path}'`)).toBe("0");
    const after = await page.request.get(`/api/files/${id}?disposition=attachment`, { headers: { "Sec-Fetch-Site": "same-origin" }, maxRedirects: 0 });
    expect(after.status()).toBe(303);
    expect(new URL(after.headers()["location"], "http://localhost:3100").pathname).toBe("/files/unavailable");
    const dead = (await fetch(fresh)).status;
    expect(dead).toBeGreaterThanOrEqual(400);
    expect(dead).toBeLessThan(500);
    expect(errors).toEqual([]);
    await context.close();
  });

  test("rep_cannot_open_others_file with real bytes: the admin reaches Storage, the rep gets unavailable", async ({ browser }) => {
    test.setTimeout(240_000);
    // Verifier 4d finding 2: a real stored file, so the only difference between the two answers is who asks.
    const token = await aal2Token(adminEmail, adminSecret);
    const body = pdfBytes(8192);
    const begun = await rpc(token, "begin_file_upload", { p_company: lead, p_name: "Confidentiel stocké.pdf", p_mime: "application/pdf", p_size: body.length });
    expect(begun.status).toBe(200);
    expect(await putObject(token, begun.body.path, "application/pdf", body)).toBe(200);
    expect((await rpc(token, "finish_file_upload", { p_id: begun.body.id })).status).toBe(200);
    const ask = async (state: typeof adminState) => {
      const { context, page } = await open(browser, state);
      await page.goto("/leads");
      const res = await page.request.get(`/api/files/${begun.body.id}?disposition=attachment`, { headers: { "Sec-Fetch-Site": "same-origin" }, maxRedirects: 0 });
      await context.close();
      return { status: res.status(), location: new URL(res.headers()["location"], "http://localhost:3100") };
    };
    const admin = await ask(adminState);
    expect(admin.status).toBe(303);
    expect(admin.location.origin).toBe(new URL(env("SUPABASE_LOCAL_URL")).origin);
    const rep = await ask(repState);
    expect(rep.status).toBe(303);
    expect(rep.location.origin).toBe("http://localhost:3100");
    expect(rep.location.pathname).toBe("/files/unavailable");
  });

  test("signed_upsert_overwrite_after_ready_refused: a signed upload link made with upsert while pending cannot swap a ready file", async ({ browser }) => {
    test.setTimeout(240_000);
    // Verifier 4d round 2 finding 1. storage-api checks the policies only when a signed upload link is made; with
    // x-upsert the bytes later sent to it are written as its own superuser. The link is made while the file is pending,
    // the genuine PDF is sent through it and finished, then other bytes of the same size and type are sent to the same
    // link. The ready row is bound to the object version checked at finish, so the open must answer "unavailable".
    const token = await aal2Token(adminEmail, adminSecret);
    const genuine = pdfBytes(8192);
    const swapped = Buffer.from(genuine);
    swapped.write("%PDF-1.7 other bank details", 0, "latin1");
    const begun = await rpc(token, "begin_file_upload", { p_company: lead, p_name: "Facture signée.pdf", p_mime: "application/pdf", p_size: genuine.length });
    expect(begun.status).toBe(200);
    const auth = { apikey: env("NEXT_PUBLIC_SUPABASE_ANON_KEY"), Authorization: `Bearer ${token}` };
    const sign = await fetch(`${env("SUPABASE_LOCAL_URL")}/storage/v1/object/upload/sign/lead-files/${begun.body.path}`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "x-upsert": "true" },
      body: "{}",
    });
    expect(sign.status).toBe(200);
    const signedUrl = `${env("SUPABASE_LOCAL_URL")}/storage/v1${((await sign.json()) as { url: string }).url}`;
    const send = async (body: Buffer) =>
      (await fetch(signedUrl, { method: "PUT", headers: { "content-type": "application/pdf", "x-upsert": "true", "cache-control": "max-age=0" }, body: new Uint8Array(body) })).status;
    expect(await send(genuine)).toBe(200);
    expect((await rpc(token, "finish_file_upload", { p_id: begun.body.id })).status).toBe(200);
    const versionAtFinish = sql(`select version from storage.objects where bucket_id = 'lead-files' and name = '${begun.body.path}'`);
    expect(sql(`select object_version from public.files where id = '${begun.body.id}'`)).toBe(versionAtFinish);
    const { context, page } = await open(browser, adminState);
    await page.goto("/leads");
    const ask = async () => {
      const res = await page.request.get(`/api/files/${begun.body.id}?disposition=attachment`, { headers: { "Sec-Fetch-Site": "same-origin" }, maxRedirects: 0 });
      expect(res.status()).toBe(303);
      return new URL(res.headers()["location"], "http://localhost:3100");
    };
    expect((await ask()).origin).toBe(new URL(env("SUPABASE_LOCAL_URL")).origin); // as checked at finish: opens
    const overwrite = await send(swapped);
    const versionNow = sql(`select version from storage.objects where bucket_id = 'lead-files' and name = '${begun.body.path}'`);
    test.info().annotations.push({ type: "signed upsert after ready", description: JSON.stringify({ overwrite_status: overwrite, version_changed: versionNow !== versionAtFinish }) });
    const after = await ask();
    if (overwrite >= 200 && overwrite < 300) {
      // storage-api replaced the ready object (the gap the finding describes): the open refuses it.
      expect(versionNow).not.toBe(versionAtFinish);
      expect(after.origin).toBe("http://localhost:3100");
      expect(after.pathname).toBe("/files/unavailable");
    } else {
      // storage-api refused the overwrite: the object is the one checked at finish and still opens.
      expect(versionNow).toBe(versionAtFinish);
      expect(after.origin).toBe(new URL(env("SUPABASE_LOCAL_URL")).origin);
    }
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
