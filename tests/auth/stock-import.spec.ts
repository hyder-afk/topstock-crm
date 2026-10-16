import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { decodeBytes, parseCsvText } from "@/lib/import";
import { ageStepUp, appReady, createUser, expectChosen, fullSession, isCancelledPrefetch, nextWindow, setRole, settled, sql, totp, trackRequests } from "./helpers";

// The stock sheet import (Day 6c, design 11.5): the fake 40-row sheet matched with zero clicks, French numbers, the
// check's tiles and REVENTE warnings, the problems file (formula-guarded), the import; a re-import that keeps a
// quantity sold in the CRM, the "use the sheet's quantities" switch, a transit product arriving as a transfer; the undo
// with its preview; the Windows-1252, English and parentheses-only sheets; a rep gets 404; the working rows are not
// reachable over REST. Then the evidence screenshots. Product names carry the run tag (the local stack is reused), and
// people are picked by e-mail.
test.describe.configure({ mode: "serial" });

const fixtures = path.resolve(__dirname, "../fixtures/stock");
const expected = JSON.parse(readFileSync(path.join(fixtures, "expected.json"), "utf8"));
const password = "StockImport-Pass-42!";
const run = Date.now();
const tag = `T${String(run).slice(-6)}`;
const adminEmail = `si-admin-${run}@example.test`;
const repEmail = `si-rep-${run}@example.test`;
let adminSecret = "";
let adminState: Awaited<ReturnType<BrowserContext["storageState"]>>;
let repState: Awaited<ReturnType<BrowserContext["storageState"]>>;

function userId(email: string) {
  return sql(`select id from auth.users where email = '${email}'`);
}
function asUser(email: string, body: string) {
  const claims = `json_build_object('sub', '${userId(email)}', 'role', 'authenticated', 'aal', 'aal2', 'amr',
                   json_build_array(json_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint)))::text`;
  return sql(`begin; select set_config('request.jwt.claims', ${claims}, true); set local role authenticated; ${body}; commit;`);
}
const q = (s: string) => s.replace(/'/g, "''");
const level = (name: string, kind: "warehouse" | "transit") =>
  sql(`select coalesce((select l.on_hand from public.stock_levels l join public.locations x on x.id = l.location_id
        join public.products p on p.id = l.product_id where p.name = '${q(name)}' and x.kind = '${kind}'), 0)`);

// A fixture sheet with the run tag after every product name (blank names stay blank), in the same encoding style.
async function tagged(file: string, extraTag = tag) {
  const decoded = decodeBytes(new Uint8Array(readFileSync(path.join(fixtures, file))));
  const parsed = await parseCsvText(decoded.text, { sepHint: decoded.sepHint, schedule: (resume) => resume() });
  const d = parsed.delimiter;
  const cell = (v: string) => (/["\r\n]/.test(v) || v.includes(d) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [parsed.rawHeaders, ...parsed.records.map((r) => r.cells.map((c, i) => (i === 0 && c.trim() ? `${c.trim()} ${extraTag}` : c)))];
  const names = new Map(parsed.records.map((r) => [r.row_no, r.cells[0]?.trim() ? `${r.cells[0].trim()} ${extraTag}` : ""]));
  const text = String.fromCodePoint(0xfeff) + lines.map((l) => l.map(cell).join(d)).join("\r\n") + "\r\n";
  return { file: { name: file.replace(".csv", `-${extraTag}.csv`), mimeType: "text/csv", buffer: Buffer.from(text, "utf8") }, names };
}

async function open(browser: Browser, state: typeof adminState, o: { width?: number; locale?: string; scheme?: "light" | "dark" } = {}) {
  const width = o.width ?? 1440;
  const context = await browser.newContext({
    storageState: state,
    viewport: { width, height: width < 600 ? 844 : 900 },
    hasTouch: width < 600,
    colorScheme: o.scheme ?? "light",
    timezoneId: "Europe/Paris",
    acceptDownloads: true,
  });
  if (o.locale) {
    // The app's address from the Playwright config (PLAYWRIGHT_BASE_URL, else port 3100), as share.spec reads it.
    const base = test.info().project.use.baseURL;
    if (!base) throw new Error("baseURL is not set (playwright.auth.config.ts)");
    await context.addCookies([{ name: "locale", value: o.locale, url: new URL(base).origin }]);
  }
  const page = await context.newPage();
  trackRequests(page);
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && !isCancelledPrefetch(m.text()) && errors.push(m.text()));
  page.on("pageerror", (e) => !isCancelledPrefetch(e.message) && errors.push(e.message));
  return { context, page, errors };
}

async function gotoImport(page: Page) {
  await settled(page);
  await page.goto("/inventory/import");
  await expect(page.locator("main h1")).toBeVisible();
  await appReady(page);
}

// Enters a code when "Confirm it's you" opens (the session's code may be older than the step allows).
async function codeIfAsked(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Confirm it’s you" });
  if (await dialog.isVisible().catch(() => false)) {
    await nextWindow();
    await dialog.getByLabel("6-digit code").fill(totp(adminSecret));
    await expect(dialog).toBeHidden();
  }
}

async function chooseAndCheck(page: Page, file: { name: string; mimeType: string; buffer: Buffer }) {
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByRole("heading", { name: "Match the columns" })).toBeVisible();
  await page.getByRole("button", { name: /^Check\b/ }).click();
  await page.waitForTimeout(300);
  await codeIfAsked(page);
  await expect(page.getByRole("heading", { name: "What this import will do" })).toBeVisible({ timeout: 30_000 });
}

const tileValue = (page: Page, label: string) => page.getByRole("group", { name: label, exact: true }).locator(".font-mono");
const history = (page: Page) => page.locator("section").filter({ has: page.getByRole("heading", { name: "Past imports" }) });
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

async function discardCheck(page: Page) {
  await page.getByRole("button", { name: "Discard", exact: true }).first().click();
  const confirm = page.getByRole("dialog", { name: "Discard this check?" });
  await confirm.getByRole("button", { name: "Discard" }).click();
  await codeIfAsked(page);
  await expect(page.getByRole("heading", { name: "Choose your stock sheet" })).toBeVisible();
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  adminSecret = await createUser(adminEmail, password, true);
  const repSecret = await createUser(repEmail, password, true);
  setRole(adminEmail, "admin");
  setRole(repEmail, "rep");
  sql(`update public.profiles set first_name = 'Haider', last_name = 'Test' where id = '${userId(adminEmail)}'`);
  // Earlier runs on this reused stack may have left open stock imports (3 at most per organisation): discard them.
  sql(`do $$ declare b uuid; begin for b in select id from public.import_batches where kind = 'stock' and status in ('staged', 'dry_run') loop
         perform set_config('topstock.stock_batch_op', b::text, true); update public.import_batches set status = 'discarded' where id = b; end loop; end $$`);
  adminState = await fullSession(browser, adminEmail, password, adminSecret);
  repState = await fullSession(browser, repEmail, password, repSecret);
});

test("import_stock_40_zero_click_match, stock_problems_file_formula_guarded, stock_step_up_dialog_flow", async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page, errors } = await open(browser, adminState);
  await ageStepUp(context, 700);
  await gotoImport(page);
  await expect(page.locator("main h1")).toHaveText("Import a stock sheet");
  const { file, names } = await tagged("stock-40-fake.csv");
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByRole("heading", { name: "Match the columns" })).toBeFocused();
  // Zero clicks: all nine columns matched, French numbers read from the file, every STATUS spelling known.
  await expect(page.getByText("Matched", { exact: true })).toHaveCount(9);
  await expectChosen(page.getByLabel("Number style"), "fr");
  await expect(page.getByText(/^Numbers look like .+ → .+/)).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "rows ready" })).toHaveText(/32 rows ready · 7 can’t be imported/);
  // The code is 700 s old: "Confirm it's you" before anything is sent.
  await page.getByRole("button", { name: /^Check\b/ }).click();
  const stepUp = page.getByRole("dialog", { name: "Confirm it’s you" });
  await expect(stepUp).toBeVisible();
  await nextWindow();
  await stepUp.getByLabel("6-digit code").fill(totp(adminSecret));
  await expect(page.getByRole("heading", { name: "What this import will do" })).toBeVisible({ timeout: 30_000 });
  const want = expected.check_on_empty_catalogue;
  await expect(tileValue(page, "New products")).toHaveText(String(want.products_new));
  await expect(tileValue(page, "Updated")).toHaveText("0");
  await expect(tileValue(page, "Can’t import")).toHaveText(String(want.rejected));
  await expect(page.getByText(`${want.repeated} repeated rows · 0 products unchanged`)).toBeVisible();
  await expect(page.getByText("REVENTE MAX doesn’t match quantity × max price on 2 rows")).toBeVisible();
  await expect(page.getByText("REVENTE MIN doesn’t match quantity × min price on 1 row")).toBeVisible();
  await expect(page.getByText("2 rows have prices that differ between warehouse and transit")).toBeVisible();
  // Rows to look at carry the names from the file in this browser; the problems file is formula-guarded.
  await expect(page.getByText("Same product and place as row 17")).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /^Download rows not imported/ }).click()]);
  const csv = readFileSync(await download.path(), "utf8");
  const lines = csv.replace(/^\uFEFF/, "").trim().split("\r\n");
  expect(lines[0].startsWith('"Row";"Problem";"CATÉGORIE"')).toBe(true);
  expect(lines).toHaveLength(1 + want.rejected + want.repeated);
  expect(csv).toContain(`"'-5"`);
  expect(csv).toContain("Quantity isn’t a number");
  // The change table lists every new product.
  await expect(page.getByRole("table").getByRole("rowheader")).toHaveCount(28);
  // Import.
  await page.getByRole("button", { name: /^Import 28 new products/ }).click();
  await expect(page.getByRole("heading", { name: "Import done" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("28 products added · 0 updated")).toBeVisible();
  const formula = `${expected.names.formula} ${tag}`;
  expect(sql(`select count(*) from public.products where name = '${q(formula)}'`)).toBe("1");
  expect(sql(`select count(*) from public.products where name like '% ${tag}'`)).toBe("28");
  // Cost per piece = PP / QUANTITE (Haider, 11 Oct): row 2 of the sheet.
  const first = names.get(2) ?? "";
  expect(Number(sql(`select c.cost_per_piece from private.product_costs c join public.products p on p.id = c.product_id where p.name = '${q(first)}'`))).toBeGreaterThan(0);
  expect(level(first, "warehouse")).toBe("1200");
  await expect(history(page).getByRole("listitem").first()).toContainText("Imported");
  expect(errors).toEqual([]);
  await context.close();
});

test("reimport_keeps_crm_moved_quantities, reimport_use_sheet_option, reimport_transit_arrived_as_transfer", async ({ browser }) => {
  test.setTimeout(240_000);
  const { file, names } = await tagged("stock-reimport-fake.csv");
  const rowOf = (change: string) => Number(Object.entries(expected.reimport.rows as Record<string, { change: string }>).find(([, v]) => v.change === change)?.[0]);
  const sold = names.get(rowOf("sold_in_crm")) ?? "";
  const arrived = names.get(rowOf("arrived")) ?? "";
  const soldBefore = Number(level(sold, "warehouse"));
  const arrivedTransit = Number(level(arrived, "transit"));
  expect(arrivedTransit).toBeGreaterThan(0);
  // Sold in the CRM since the sheet (a correction stands in for a sale until 6d).
  asUser(adminEmail, `select public.post_stock_movement((select id from public.products where name = '${q(sold)}'), 'adjust_out', 5, 'warehouse', 'sample')`);

  const { context, page, errors } = await open(browser, adminState);
  await gotoImport(page);
  await chooseAndCheck(page, file);
  await expect(tileValue(page, "New products")).toHaveText("2");
  await expect(tileValue(page, "Updated")).toHaveText("7");
  await expect(tileValue(page, "Kept (changed in the CRM)")).toHaveText("1");
  await expect(page.getByText("0 repeated rows · 1 product unchanged")).toBeVisible();
  // Use the sheet's quantity for the kept product, then go back to the CRM's numbers.
  await page.getByRole("button", { name: "Use the sheet’s quantity for it" }).click();
  await codeIfAsked(page);
  await expect(tileValue(page, "Kept (changed in the CRM)")).toHaveText("0");
  await expect(tileValue(page, "Updated")).toHaveText("8");
  await page.getByRole("button", { name: "Keep the CRM’s numbers" }).click();
  await codeIfAsked(page);
  await expect(tileValue(page, "Kept (changed in the CRM)")).toHaveText("1");
  await page.getByRole("button", { name: /^Import 2 new products and update 8/ }).click();
  await expect(page.getByRole("heading", { name: "Import done" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("2 products added · 8 updated")).toBeVisible();
  await expect(page.getByText("1 product kept its CRM quantities.")).toBeVisible();
  // Kept: the sale stands. Arrived: transit to warehouse as a transfer pair tagged with the import.
  expect(Number(level(sold, "warehouse"))).toBe(soldBefore - 5);
  expect(level(arrived, "transit")).toBe("0");
  expect(Number(level(arrived, "warehouse"))).toBeGreaterThanOrEqual(arrivedTransit);
  expect(sql(`select count(*) from private.stock_movements m join public.products p on p.id = m.product_id
              where p.name = '${q(arrived)}' and m.kind = 'transfer_in' and m.import_batch_id is not null`)).toBe("1");
  expect(errors).toEqual([]);
  await context.close();
});

test("stock_undo_preview_and_run, stock_undo_keeps_sold", async ({ browser }) => {
  test.setTimeout(180_000);
  const { names } = await tagged("stock-reimport-fake.csv");
  const rowOf = (change: string) => Number(Object.entries(expected.reimport.rows as Record<string, { change: string }>).find(([, v]) => v.change === change)?.[0]);
  const arrived = names.get(rowOf("arrived")) ?? "";
  const sold = names.get(rowOf("sold_in_crm")) ?? "";
  const soldNow = level(sold, "warehouse");
  const fresh = names.get(rowOf("new")) ?? "";
  const { context, page, errors } = await open(browser, adminState);
  await gotoImport(page);
  const latest = history(page).getByRole("listitem").filter({ hasText: `stock-reimport-fake-${tag}.csv` });
  await latest.getByRole("button", { name: "Undo" }).click();
  await codeIfAsked(page);
  const dialog = page.getByRole("dialog", { name: "Undo this import?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/^Quantities go back on \d+ products?/)).toBeVisible();
  await expect(dialog.getByText("2 new products archived.")).toBeVisible();
  await dialog.getByRole("button", { name: "Undo import" }).click();
  await expect(page.getByRole("dialog", { name: "Import undone" })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("dialog", { name: "Import undone" }).getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("heading", { name: "Past imports" })).toBeFocused();
  await expect(latest).toContainText("Undone");
  // The arrival goes back to transit; the product sold in the CRM keeps its quantity; new products are archived.
  expect(Number(level(arrived, "transit"))).toBeGreaterThan(0);
  expect(level(sold, "warehouse")).toBe(soldNow);
  expect(sql(`select archived_at is not null from public.products where name = '${q(fresh)}'`)).toBe("t");
  expect(errors).toEqual([]);
  await context.close();
});

test("cp1252_variant, parens_only_headers, stock_import_en_file", async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page, errors } = await open(browser, adminState);
  await gotoImport(page);
  // Windows-1252: read as Western European (a notice says so), the same zero-click match.
  await page.locator('input[type="file"]').setInputFiles(path.join(fixtures, "stock-40-fake-cp1252.csv"));
  await expect(page.getByRole("heading", { name: "Match the columns" })).toBeVisible();
  await expect(page.getByText(/read as Western European/)).toBeVisible();
  await expect(page.getByText("Matched", { exact: true })).toHaveCount(9);
  await expectChosen(page.getByLabel("Number style"), "fr");
  await page.getByRole("button", { name: "Choose another file" }).click();
  // Parentheses only: min and max read inside them.
  const parens = await tagged("stock-parens-only.csv");
  await chooseAndCheck(page, parens.file);
  await expect(tileValue(page, "New products")).toHaveText("6");
  await expect(tileValue(page, "Can’t import")).toHaveText("0");
  await discardCheck(page);
  // English headers and numbers.
  const en = await tagged("stock-en-headers.csv");
  await page.locator('input[type="file"]').setInputFiles(en.file);
  await expectChosen(page.getByLabel("Number style"), "en");
  await expect(page.getByText("Matched", { exact: true })).toHaveCount(9);
  await page.getByRole("button", { name: /^Check\b/ }).click();
  await page.waitForTimeout(300);
  await codeIfAsked(page);
  await expect(tileValue(page, "New products")).toHaveText("8");
  await discardCheck(page);
  expect(errors).toEqual([]);
  await context.close();
});

test("stock_import_rep_404, stock_staging_not_exposed", async ({ browser }) => {
  const { context, page } = await open(browser, repState);
  await page.goto("/inventory/import");
  await expect(page.locator("main h1")).toHaveText("This page isn’t here");
  await page.goto("/inventory");
  await expect(page.locator("main h1")).toContainText("Inventory");
  await appReady(page);
  await expect(page.getByRole("link", { name: "Import sheet" })).toHaveCount(0);
  // The rep's own session cannot read the routes either (the database refuses: 403).
  const res = await page.request.get(`/api/stock-imports/${sql(`select id from public.import_batches where kind = 'stock' order by created_at desc limit 1`)}/issues`);
  expect(res.status()).toBe(403);
  await context.close();
  // The working rows and the changes ledger have no REST endpoint (private schema).
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  for (const table of ["stock_import_staging", "stock_import_changes"]) {
    const r = await fetch(`${process.env.SUPABASE_LOCAL_URL}/rest/v1/${table}?select=*`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    // Real PostgREST answers 404 (no such relation in the exposed schemas); the local gateway stand-in answers 400.
    expect([400, 401, 404, 406]).toContain(r.status);
  }
});

test("screens", async ({ browser }) => {
  test.setTimeout(900_000);
  const out = path.resolve(__dirname, "../../test-results/stock-import-screens");
  mkdirSync(out, { recursive: true });
  const widths = [390, 768, 1024, 1280, 1440, 1728];
  let n = 0;
  for (const locale of ["en", "fr"]) {
    for (const scheme of ["light", "dark"] as const) {
      for (const width of widths) {
        const { context, page, errors } = await open(browser, adminState, { width, locale, scheme });
        await settled(page);
        await page.goto("/inventory/import");
        await appReady(page);
        const shot = async (name: string) => {
          await page.waitForTimeout(250);
          expect(await noSideways(page), `${name} ${locale} ${scheme} ${width}`).toBeLessThanOrEqual(0);
          await page.screenshot({ path: path.join(out, `${name}-${locale}-${scheme}-${width}.png`), fullPage: true });
        };
        await shot("choose");
        const { file } = await tagged("stock-40-fake.csv", `S${n++}`);
        await page.locator('input[type="file"]').setInputFiles(file);
        await expect(page.locator("#stock-step-heading")).toBeFocused();
        await shot("match");
        await page.getByRole("button", { name: /^(Check|Vérifier)/ }).first().click();
        await page.waitForTimeout(300);
        const dialog = page.getByRole("dialog");
        if (await dialog.isVisible().catch(() => false)) {
          await nextWindow();
          await dialog.locator("input").first().fill(totp(adminSecret));
        }
        await expect(page.getByRole("group").first()).toBeVisible({ timeout: 30_000 });
        await page.getByRole("table").waitFor();
        await shot("check");
        // Thrown away again (at most 3 open stock imports).
        const id = sql(`select id from public.import_batches where kind = 'stock' and status = 'dry_run' order by created_at desc limit 1`);
        sql(`do $$ begin perform set_config('topstock.stock_batch_op', '${id}', true); update public.import_batches set status = 'discarded' where id = '${id}'; end $$`);
        expect(errors, `${locale} ${scheme} ${width}`).toEqual([]);
        await context.close();
      }
    }
  }
});
