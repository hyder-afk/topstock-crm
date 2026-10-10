import { readFileSync } from "node:fs";
import path from "node:path";
import Papa from "papaparse";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ageStepUp, appReady, createUser, fullSession, nextWindow, setRole, sql, totp } from "./helpers";

// Lead import (Day 3b): an admin imports the fake sample files end to end (choose, match, check, import, undo), the
// problems file, a check that fails part way (thrown away, choices kept), a paused import resumed, a checked import
// reviewed later with its file chosen again, bad files, the phone layout, the "Confirm it's you" step when the last
// code is too old, and a rep who has no way in. Fixtures are the made-up files
// in tests/fixtures/import (expected.json lists what every row of the 500-row sample must become).
test.describe.configure({ mode: "serial" });

const fixtures = path.join(__dirname, "..", "fixtures", "import");
const expected = JSON.parse(readFileSync(path.join(fixtures, "expected.json"), "utf8")) as {
  totals: { ready: number; duplicate_file: number; duplicate_existing: number; rejected: number };
};

const password = "Import-Pass-42!";
const run = Date.now();
const adminEmail = `import-admin-${run}@example.test`;
const repEmail = `import-rep-${run}@example.test`;
let adminSecret = "";
let adminState: Awaited<ReturnType<BrowserContext["storageState"]>>;
let adminSignedAt = 0;
let repState: Awaited<ReturnType<BrowserContext["storageState"]>>;
let problemsFile = "";

const profileOf = (email: string) => `(select id from auth.users where email = '${email}')`;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  // A clean slate: no leads, no imports, and nobody else called "Haider/Henri/Kais Test" (the owners in the files).
  sql(`delete from public.companies; delete from public.import_batches;
       update public.profiles set last_name = 'Earlier run'
       where last_name = 'Test' and first_name in ('Haider', 'Henri', 'Kais')`);
  adminSecret = await createUser(adminEmail, password, true);
  const repSecret = await createUser(repEmail, password, true);
  setRole(adminEmail, "admin");
  setRole(repEmail, "rep");
  sql(`update public.profiles set first_name = 'Haider', last_name = 'Test' where id = ${profileOf(adminEmail)}`);
  sql(`update public.profiles set first_name = 'Kais', last_name = 'Test' where id = ${profileOf(repEmail)}`);
  // Henri is a team member who never signs in here (owner names in the files only).
  const henri = `import-henri-${run}@example.test`;
  await createUser(henri, password, false);
  sql(`update public.profiles set first_name = 'Henri', last_name = 'Test' where id = ${profileOf(henri)}`);
  repState = await fullSession(browser, repEmail, password, repSecret);
  adminState = await fullSession(browser, adminEmail, password, adminSecret);
  adminSignedAt = Date.now();
});

// The admin's code stays fresh for 10 minutes and the screen asks again when fewer than 3 are left: sign in again
// when the suite has run long enough for that (keeps the dialog out of the tests that are not about it).
async function adminContext(browser: Browser, viewport = { width: 1440, height: 900 }) {
  if (Date.now() - adminSignedAt > 330_000) {
    adminState = await fullSession(browser, adminEmail, password, adminSecret);
    adminSignedAt = Date.now();
  }
  return browser.newContext({ storageState: adminState, viewport, acceptDownloads: true });
}

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  // A lead named <script>alert("x")</script> must stay text.
  page.on("dialog", (d) => {
    errors.push(`dialog: ${d.message()}`);
    void d.dismiss();
  });
  return errors;
}

async function openImport(page: Page) {
  await page.goto("/leads/import");
  await expect(page.locator("main h1")).toHaveText("Import leads");
  await expect(page.getByRole("heading", { name: "Choose your file" })).toBeVisible();
  await appReady(page);
}

async function choose(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }) {
  await page.locator('input[type="file"]').setInputFiles(typeof file === "string" ? path.resolve(fixtures, file) : file);
}

const tile = (page: Page, label: string) => page.locator("dl > div").filter({ hasText: label }).locator("dd").first();
const checkButton = (page: Page) => page.getByRole("button", { name: /^Check file/ });
const history = (page: Page) => page.getByRole("complementary", { name: "Past imports" });
// The import of this file that is still in play (a discarded check of the same file stays listed too).
const historyItem = (page: Page, file: string) =>
  history(page).getByRole("listitem").filter({ hasText: file }).filter({ hasNotText: "Discarded" });
const noHorizontalScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
// Discard asks first ("Discard this check?"), then the import is thrown away.
async function discardAndConfirm(page: Page) {
  await page.getByRole("button", { name: "Discard" }).first().click();
  const confirm = page.getByRole("dialog", { name: "Discard this check?" });
  await expect(confirm).toContainText("Nothing was added to your CRM.");
  await confirm.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByText("Import discarded.")).toBeVisible();
}

function batchId(filename: string, status: string) {
  return sql(`select id from public.import_batches where filename = '${filename}' and status = '${status}'
              order by created_at desc limit 1`);
}

test("a rep has no import page, no import buttons, and the rows of an import stay closed", async ({ browser }) => {
  const context = await browser.newContext({ storageState: repState, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto("/leads/import");
  await expect(page.locator("main h1")).toHaveText("This page isn’t here");
  await expect(page.getByRole("heading", { name: "Import leads" })).toHaveCount(0);
  await page.goto("/leads");
  await expect(page.locator("main h1")).toContainText("Leads");
  await appReady(page);
  await expect(page.getByRole("link", { name: /^Import/ })).toHaveCount(0);
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command menu" });
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox").fill("import");
  await expect(palette.getByRole("option", { name: /Import leads/ })).toHaveCount(0);
  // The issues endpoint answers a rep with "forbidden" (the database refuses; no rows, no codes).
  const response = await context.request.get(`/api/imports/${crypto.randomUUID()}/issues`);
  expect(response.status()).toBe(403);
  expect(await response.json()).toEqual({ error: "forbidden" });
  await context.close();
});

test("existing-20.csv: every column matched on its own, 20 leads checked and imported", async ({ browser }) => {
  const context = await adminContext(browser);
  const page = await context.newPage();
  const errors = watchErrors(page);
  await openImport(page);
  await expect(history(page)).toContainText("No imports yet.");
  await choose(page, "existing-20.csv");
  await expect(page.getByRole("heading", { name: "Match your columns" })).toBeFocused();
  await expect(page.getByText("existing-20.csv · 20 rows · 8 columns · separated by ,")).toBeVisible();
  await expect(page.getByText("Matched", { exact: true })).toHaveCount(8);
  await expect(page.getByText("We matched 3 of 3 owner names to your team.", { exact: false })).toBeVisible();
  await checkButton(page).click();
  // No "Confirm it's you": the code from sign-in is still fresh.
  await expect(page.getByRole("heading", { name: "Check results" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(tile(page, "Will be added")).toHaveText("20");
  await expect(tile(page, "Already in the CRM")).toHaveText("0");
  await expect(tile(page, "Repeated in this file")).toHaveText("0");
  await expect(tile(page, "Can’t be imported")).toHaveText("0");
  await page.getByRole("button", { name: /^Import 20 leads/ }).click();
  await expect(page.getByRole("heading", { name: "20 leads added" })).toBeVisible();
  await expect(historyItem(page, "existing-20.csv")).toContainText("Imported");
  await expect(historyItem(page, "existing-20.csv")).toContainText("20 added");
  expect(sql(`select count(*) from public.companies where import_batch_id is not null`)).toBe("20");
  // The owners came from the names in the file ("kais test" is Kais Test).
  expect(sql(`select count(distinct owner_id) from public.companies`)).toBe("3");
  // The column matching is remembered under a hash of the header row: no header text in this browser's storage.
  const stored = await page.evaluate(() => Object.entries(window.localStorage));
  const mappingKeys = stored.map(([key]) => key).filter((key) => key.startsWith("topstock.import.mapping."));
  expect(mappingKeys).toHaveLength(1);
  expect(mappingKeys[0]).toMatch(/^topstock\.import\.mapping\.[0-9a-f]{64}$/);
  const storedText = JSON.stringify(stored).toLowerCase();
  for (const header of ["company name", "company owner", "phone number", "lead status", "last activity date", "country/region"]) {
    expect(storedText).not.toContain(header);
  }
  expect(errors).toEqual([]);
  await context.close();
});

test("the 500-row sample: two status words chosen, results match expected.json, problems file, 400 imported", async ({ browser }) => {
  const context = await adminContext(browser);
  const page = await context.newPage();
  const errors = watchErrors(page);
  await openImport(page);
  await choose(page, "leads-500-fake.csv");
  await expect(page.getByText("leads-500-fake.csv · 500 rows · 8 columns · separated by ,")).toBeVisible();
  // Two status words have no obvious meaning: the check waits for a choice.
  await expect(checkButton(page)).toBeDisabled();
  await expect(page.getByText("2 status words still need a choice")).toBeVisible();
  await page.getByLabel("Status for “Hot lead”").selectOption("warm");
  await page.getByLabel("Status for “Prospect”").selectOption("cold");
  // "Former Rep" is not in the team (comes in unassigned); "Atlantis" is not a country (left blank).
  await expect(page.getByText("We matched 3 of 4 owner names to your team.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Owner for “Former Rep”")).toHaveValue("");
  await expect(page.getByLabel("Country for “Atlantis”")).toHaveValue("");
  await expect(page.getByLabel("Date order")).toHaveValue("dmy");
  await expect(page.getByLabel("Time zone")).toHaveValue("Europe/Paris");
  await checkButton(page).click();

  await expect(page.getByRole("heading", { name: "Check results" })).toBeVisible();
  await expect(tile(page, "Will be added")).toHaveText(String(expected.totals.ready));
  await expect(tile(page, "Already in the CRM")).toHaveText(String(expected.totals.duplicate_existing));
  await expect(tile(page, "Repeated in this file")).toHaveText(String(expected.totals.duplicate_file));
  await expect(tile(page, "Can’t be imported")).toHaveText(String(expected.totals.rejected));
  const reasons = page.getByRole("heading", { name: "Why some rows can’t be imported" }).locator("..");
  await expect(reasons.getByRole("listitem").filter({ hasText: "Email address doesn’t look right" })).toContainText("12");
  await expect(reasons.getByRole("listitem").filter({ hasText: "The company name is empty" })).toContainText("10");
  const changes = page.getByRole("heading", { name: "Added with a change" }).locator("..");
  await expect(changes.getByRole("listitem").filter({ hasText: "comes in unassigned" })).toContainText("6");
  await expect(changes.getByRole("listitem").filter({ hasText: "Country not recognised" })).toContainText("2");

  // The rows list: filters, plain sentences, company names from the file in this browser.
  const rows = page.getByRole("list", { name: "Rows to look at" });
  await page.getByRole("button", { name: "Can’t import" }).click();
  await expect(rows.getByRole("listitem").first()).toContainText("13");
  await expect(rows.getByRole("listitem").first()).toContainText("Quincaillerie Peyrac");
  await expect(rows.getByRole("listitem").first()).toContainText("Email address doesn’t look right");
  await page.getByRole("button", { name: "Repeated", exact: true }).click();
  await expect(rows.getByRole("listitem").filter({ hasText: "Librairie Castelnau Centre" }).first()).toContainText(
    "Same company and city as row 31",
  );
  await page.getByRole("button", { name: "Already in CRM" }).click();
  await expect(rows.getByRole("listitem").first()).toContainText("Already in the CRM:");
  await page.getByRole("button", { name: "All", exact: true }).click();

  // The problems file: every row not imported, with its reason, safe to open in Excel.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download rows not imported (CSV)" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^leads-500-fake-rows-not-imported-\d{4}-\d{2}-\d{2}\.csv$/);
  problemsFile = test.info().outputPath("rows-not-imported.csv");
  await download.saveAs(problemsFile);
  const text = readFileSync(problemsFile, "utf8");
  expect(text.charCodeAt(0)).toBe(0xfeff);
  const parsed = Papa.parse<string[]>(text.slice(1), { skipEmptyLines: true });
  const [header, ...lines] = parsed.data;
  expect(header.slice(0, 4)).toEqual(["Row", "Problem", "Company name", "Company owner"]);
  expect(lines).toHaveLength(expected.totals.rejected + expected.totals.duplicate_file + expected.totals.duplicate_existing);
  expect(lines.find((l) => l[0] === "13")?.[1]).toBe("Email address doesn’t look right");
  // A formula-like company name gets a leading apostrophe so Excel shows it as text.
  expect(lines.find((l) => l[0] === "44")?.[2]).toBe(`'=HYPERLINK("http://example.invalid")`);

  await page.getByRole("button", { name: /^Import 400 leads/ }).click();
  await expect(page.getByRole("heading", { name: "400 leads added" })).toBeVisible();
  const id = batchId("leads-500-fake.csv", "imported");
  expect(sql(`select count(*) from public.companies where import_batch_id = '${id}'`)).toBe("400");
  expect(sql(`select count(*) from public.companies`)).toBe("420");
  // Unassigned: the 40 ready rows with no owner in the file and the 6 of "Former Rep". The <script> name is plain text.
  expect(sql(`select count(*) from public.companies where import_batch_id = '${id}' and owner_id is null`)).toBe("46");
  expect(sql(`select count(*) from public.companies where name = '<script>alert("x")</script>'`)).toBe("1");

  // "See these leads": the leads list filtered to this import.
  await page.getByRole("link", { name: "See these leads" }).click();
  await expect(page).toHaveURL(new RegExp(`/leads\\?batch=${id}`));
  await expect(page.locator("main h1")).toContainText("400");
  await expect(page.getByText("From an import")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search leads" }).fill("script");
  await expect(page.getByRole("table", { name: "Leads" }).getByRole("link").first()).toContainText('<script>alert("x")</script>');
  await noHorizontalScroll(page);
  expect(errors).toEqual([]);
  await context.close();
});

test("a check that fails part way is thrown away, and every choice on Match stays", async ({ browser }) => {
  const context = await adminContext(browser);
  const page = await context.newPage();
  const errors = watchErrors(page);
  await openImport(page);
  await choose(page, "leads-500-fake.csv");
  await page.getByLabel("Status for “Hot lead”").selectOption("warm");
  await page.getByLabel("Status for “Prospect”").selectOption("cold");
  await page.getByLabel("Empty status").selectOption("warm");
  await page.getByLabel("Owner for “Former Rep”").selectOption({ label: "Henri Test" });
  await page.getByLabel("Date order").selectOption("mdy");
  await page.getByLabel("Time zone").selectOption("Europe/London");
  // The connection drops once the import is created: the rows (and their 3 retries) never arrive.
  let calls = 0;
  await page.route("**/leads/import", async (route) => {
    const request = route.request();
    if (request.method() === "POST" && request.headers()["next-action"]) {
      calls += 1;
      if (calls >= 2 && calls <= 5) return route.abort();
    }
    return route.continue();
  });
  await checkButton(page).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("Connection lost.");
  // Back on Match, focus on its heading, with every choice as it was.
  await expect(page.getByRole("heading", { name: "Match your columns" })).toBeFocused();
  await expect(page.getByLabel("Status for “Hot lead”")).toHaveValue("warm");
  await expect(page.getByLabel("Status for “Prospect”")).toHaveValue("cold");
  await expect(page.getByLabel("Empty status")).toHaveValue("warm");
  await expect(page.getByLabel("Owner for “Former Rep”")).not.toHaveValue("");
  await expect(page.getByLabel("Date order")).toHaveValue("mdy");
  await expect(page.getByLabel("Time zone")).toHaveValue("Europe/London");
  await expect(checkButton(page)).toBeEnabled();
  // The half-sent import was thrown away, so trying again starts a fresh one (and never fills the 3 open slots).
  await expect
    .poll(() => sql(`select count(*) from public.import_batches where filename = 'leads-500-fake.csv' and status in ('staged', 'dry_run')`))
    .toBe("0");
  await page.unroute("**/leads/import");
  // The aborted requests are logged by the browser; nothing else may be.
  expect(errors.filter((e) => !e.includes("Failed to load resource"))).toEqual([]);
  await context.close();
});

test("the rows-not-imported file goes back in as is: nothing new, the same rows still can't be imported", async ({ browser }) => {
  expect(problemsFile).not.toBe("");
  const context = await adminContext(browser);
  const page = await context.newPage();
  const errors = watchErrors(page);
  await openImport(page);
  await choose(page, problemsFile);
  // "Row" and "Problem" are not lead fields; the original columns match as before.
  await expect(page.getByText("Matched", { exact: true })).toHaveCount(8);
  for (const select of await page.getByLabel(/^Status for/).all()) {
    if ((await select.inputValue()) === "") await select.selectOption("cold");
  }
  await checkButton(page).click();
  await expect(page.getByRole("heading", { name: "Check results" })).toBeVisible();
  // The repeated rows' first copies and the leads already in the CRM are all in the CRM now.
  await expect(tile(page, "Will be added")).toHaveText("0");
  await expect(tile(page, "Already in the CRM")).toHaveText(String(expected.totals.duplicate_file + expected.totals.duplicate_existing));
  await expect(tile(page, "Can’t be imported")).toHaveText(String(expected.totals.rejected));
  await expect(page.getByText("Nothing new to import.")).toBeVisible();
  await discardAndConfirm(page);
  await expect(page.getByRole("heading", { name: "Choose your file" })).toBeFocused();
  expect(errors).toEqual([]);
  await context.close();
});

test("undo removes the leads nobody worked on and keeps the one with a new contact", async ({ browser }) => {
  const id = batchId("leads-500-fake.csv", "imported");
  // Someone added a contact to one imported lead since: that lead is worked on and stays.
  sql(`insert into public.contacts (org_id, company_id, first_name, last_name)
       select org_id, id, 'Inès', 'Moreau' from public.companies
       where import_batch_id = '${id}' and name = 'Librairie Castelnau Centre'`);
  const context = await adminContext(browser);
  const page = await context.newPage();
  const errors = watchErrors(page);
  await openImport(page);
  await historyItem(page, "leads-500-fake.csv").getByRole("button", { name: "Undo import" }).click();
  const dialog = page.getByRole("dialog", { name: "Undo this import?" });
  await expect(dialog).toContainText("removes the 399 leads added from leads-500-fake.csv");
  await expect(dialog).toContainText("1 lead your team worked on since");
  await dialog.getByRole("button", { name: "Remove 399 leads" }).click();
  // The title says it is done, the result is announced, and Close has the focus.
  const done = page.getByRole("dialog", { name: "Import undone" });
  await expect(done).toContainText("Removed 399. Kept 1.");
  await expect(done.getByRole("button", { name: "Close" })).toBeFocused();
  await done.getByRole("button", { name: "Close" }).click();
  // The Undo button is gone: focus goes to the list's heading, never to the page.
  await expect(page.getByRole("heading", { name: "Past imports" })).toBeFocused();
  await expect(historyItem(page, "leads-500-fake.csv")).toContainText("Undone · 1 kept");
  await expect(historyItem(page, "leads-500-fake.csv").getByRole("button", { name: "Undo import" })).toHaveCount(0);
  expect(sql(`select count(*) from public.companies where import_batch_id = '${id}'`)).toBe("1");
  expect(sql(`select name from public.companies where import_batch_id = '${id}'`)).toBe("Librairie Castelnau Centre");
  expect(sql(`select count(*) from public.companies`)).toBe("21");
  expect(errors).toEqual([]);
  await context.close();
});

test("a French Windows-1252 file with ; and its own headers: owner column matched by hand, keyboard only", async ({ browser }) => {
  const context = await adminContext(browser);
  const page = await context.newPage();
  const errors = watchErrors(page);
  await openImport(page);
  await choose(page, "leads-fr-20-cp1252.csv");
  await expect(page.getByText("leads-fr-20-cp1252.csv · 20 rows · 9 columns · separated by ;")).toBeVisible();
  await expect(page.getByText("We read this file as Western European text.", { exact: false })).toBeVisible();
  // Accents decoded correctly in the examples.
  await expect(page.getByText("Pâtisserie Hélène & Fils", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Chargé de compte")).toHaveValue("ignore");
  await page.getByLabel("Chargé de compte").selectOption("owner");
  await expect(page.getByText("We matched 3 of 3 owner names to your team.", { exact: false })).toBeVisible();
  await page.locator("main h1").click();
  await page.keyboard.press("Control+Enter");
  await expect(page.getByRole("heading", { name: "Check results" })).toBeFocused();
  await expect(tile(page, "Will be added")).toHaveText("20");
  await page.keyboard.press("Control+Enter");
  await expect(page.getByRole("heading", { name: "20 leads added" })).toBeVisible();
  expect(sql(`select count(*) from public.companies where name = 'Pâtisserie Hélène & Fils' and owner_id is not null`)).toBe("1");
  expect(errors).toEqual([]);
  await context.close();
});

test("a checked import can be reviewed later (its file chosen again), and a paused import resumes where it stopped", async ({
  browser,
}) => {
  // A small file with different column names (mapped on their own), 5 made-up companies and one that can't be imported
  // (row 7: its email doesn't look right).
  const csv = [
    "Société,Ville,Pays,Courriel",
    ...["Alpha", "Brio", "Cendre", "Dune", "Écume"].map((n, i) => `Reprise ${n},Lyon,France,reprise${i}@example.test`),
    "Reprise Faux,Lyon,France,not-an-email",
  ].join("\r\n");
  const file = { name: "reprise-5.csv", mimeType: "text/csv", buffer: Buffer.from(csv, "utf8") };
  const context = await adminContext(browser);
  const page = await context.newPage();
  const errors = watchErrors(page);
  await openImport(page);
  await choose(page, file);
  await expect(page.getByText("Matched", { exact: true })).toHaveCount(4);
  await checkButton(page).click();
  await expect(tile(page, "Will be added")).toHaveText("5");

  // Leave without importing: it waits in Past imports as "Checked, not imported".
  await openImport(page);
  await expect(historyItem(page, "reprise-5.csv")).toContainText("Checked, not imported");
  await expect(historyItem(page, "reprise-5.csv")).toContainText("5 ready");
  await historyItem(page, "reprise-5.csv").getByRole("button", { name: "Review" }).click();
  await expect(page.getByRole("heading", { name: "Check results" })).toBeVisible();
  await expect(tile(page, "Will be added")).toHaveText("5");
  // Without the file the rows have no names; choosing it again on this screen brings them back (another file is refused).
  const rows = page.getByRole("list", { name: "Rows to look at" });
  await expect(rows.getByRole("listitem").first()).toContainText("Choose the file to see names");
  await page.locator('input[type="file"]').setInputFiles(path.resolve(fixtures, "existing-20.csv"));
  await expect(page.locator("main").getByRole("alert")).toContainText("This isn’t the same file.");
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(rows.getByRole("listitem").first()).toContainText("Reprise Faux");
  await expect(rows.getByRole("listitem").first()).toContainText("Email address doesn’t look right");
  await expect(page.getByRole("button", { name: "Download rows not imported (CSV)" })).toBeVisible();

  // The tab closed mid-import (the import is "committing"): Resume finishes it, nothing added twice.
  sql(`update public.import_batches set status = 'committing' where id = '${batchId("reprise-5.csv", "dry_run")}'`);
  await openImport(page);
  await expect(historyItem(page, "reprise-5.csv")).toContainText("Paused");
  await historyItem(page, "reprise-5.csv").getByRole("button", { name: "Resume" }).click();
  // The count is the import's total (from the database), also after a pause.
  await expect(page.getByRole("heading", { name: "5 leads added" })).toBeVisible();
  await expect(historyItem(page, "reprise-5.csv")).toContainText("Imported");
  expect(sql(`select count(*) from public.companies where name like 'Reprise %'`)).toBe("5");
  expect(errors).toEqual([]);
  await context.close();
});

test("files that are not CSV, or empty, are refused with a plain message", async ({ browser }) => {
  const context = await adminContext(browser);
  const page = await context.newPage();
  const errors = watchErrors(page);
  await openImport(page);
  await choose(page, "not-a-csv.xlsx");
  await expect(page.locator("main").getByRole("alert")).toHaveText(
    "This is an Excel file. In Excel: File > Save a copy > CSV UTF-8, then choose that file.",
  );
  await choose(page, "empty.csv");
  await expect(page.locator("main").getByRole("alert")).toHaveText("This file is empty.");
  await expect(page.getByRole("heading", { name: "Choose your file" })).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
});

test.describe("phone", () => {
  test("390 wide: every step fits (a long file name too), the main button stays in reach, discard works", async ({ browser }) => {
    const context = await adminContext(browser, { width: 390, height: 844 });
    const page = await context.newPage();
    const errors = watchErrors(page);
    await openImport(page);
    await expect(page.getByText("Choose a CSV file")).toBeVisible();
    await noHorizontalScroll(page);
    // An export name with no spaces wraps instead of widening the page.
    await choose(page, {
      name: "TopStock_Wholesale_HubSpot_companies_export_20261010.csv",
      mimeType: "text/csv",
      buffer: readFileSync(path.join(fixtures, "existing-20.csv")),
    });
    await expect(page.getByRole("heading", { name: "Match your columns" })).toBeVisible();
    await noHorizontalScroll(page);
    // The action bar sticks above the dock while the columns scroll.
    await expect(checkButton(page)).toBeInViewport();
    await checkButton(page).click();
    await expect(page.getByRole("heading", { name: "Check results" })).toBeVisible();
    // Everything in this file is already in the CRM now.
    await expect(tile(page, "Already in the CRM")).toHaveText("20");
    await expect(page.getByText("Nothing new to import.")).toBeVisible();
    await noHorizontalScroll(page);
    await discardAndConfirm(page);
    await expect(page.getByRole("heading", { name: "Choose your file" })).toBeVisible();
    expect(errors).toEqual([]);
    await context.close();
  });
});

// Last: it rotates the admin's session.
test("an authenticator code older than 10 minutes: “Confirm it’s you” before checking, a wrong code is refused", async ({
  browser,
}) => {
  const context = await adminContext(browser);
  await ageStepUp(context, 900);
  const page = await context.newPage();
  const errors = watchErrors(page);
  await openImport(page);
  await choose(page, "existing-20.csv");
  await checkButton(page).click();
  const dialog = page.getByRole("dialog", { name: "Confirm it’s you" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("6-digit code")).toBeFocused();
  // Cancel: nothing is sent, the columns stay as they were.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Match your columns" })).toBeVisible();
  expect(sql(`select count(*) from public.import_batches where status in ('staged', 'dry_run')`)).toBe("0");
  await checkButton(page).click();
  await expect(dialog).toBeVisible();
  const wrong = totp(adminSecret) === "000000" ? "111111" : "000000";
  await dialog.getByLabel("6-digit code").fill(wrong);
  await expect(dialog).toContainText("That code didn’t work.");
  // The field has the focus again: the next code is typed straight in, no click.
  await expect(dialog.getByLabel("6-digit code")).toBeFocused();
  await nextWindow();
  await page.keyboard.type(totp(adminSecret));
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Check results" })).toBeVisible();
  await expect(tile(page, "Already in the CRM")).toHaveText("20");
  // The new code is fresh for 10 minutes: discarding asks nothing more than its own "Discard this check?".
  await discardAndConfirm(page);
  expect(sql(`select count(*) from public.import_batches where status in ('staged', 'dry_run')`)).toBe("0");
  expect(errors).toEqual([]);
  await context.close();
});
