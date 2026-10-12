import { mkdirSync } from "node:fs";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { appReady, createUser, fullSession, isCancelledPrefetch, setRole, sql } from "./helpers";

// Evidence screenshots of the Files tab (Day 4d, design 7.6): the list at every width in both themes and both
// languages, then the empty state, refused uploads, the delete confirmation, the row menu and the unavailable page.
// Saved to test-results/files-screens (copied by hand into docs/evidence/day4d/screens). Each shot checks the URL,
// waits for the real tab, and fails on a console error or sideways scroll. Fixtures are made-up files in the local
// database (no bytes are needed to draw the list).
test.describe.configure({ mode: "serial", timeout: 900_000 });

const dir = "test-results/files-screens";
const all = [390, 768, 1024, 1280, 1440, 1728];
const full = [
  { locale: "en", scheme: "light", widths: all },
  { locale: "en", scheme: "dark", widths: all },
  { locale: "fr", scheme: "light", widths: all },
  { locale: "fr", scheme: "dark", widths: all },
] as const;
const pair = [
  { locale: "en", scheme: "light", widths: [390, 1440] },
  { locale: "fr", scheme: "dark", widths: [390, 1440] },
] as const;
const password = "Files-Screens-42!";
const run = Date.now();
const adminEmail = `files-shots-admin-${run}@example.test`;
const repEmail = `files-shots-rep-${run}@example.test`;
let state: Awaited<ReturnType<BrowserContext["storageState"]>>;
let lead = "";
let emptyLead = "";

const userId = (email: string) => sql(`select id from auth.users where email = '${email}'`);

async function shoot(
  browser: Browser,
  path: string,
  name: string,
  combos: readonly { locale: string; scheme: "light" | "dark"; widths: readonly number[] }[],
  act?: (page: Page) => Promise<void>,
  { fullPage = true }: { fullPage?: boolean } = {},
) {
  for (const { locale, scheme, widths } of combos) {
    for (const width of widths) {
      const context = await browser.newContext({ storageState: state, viewport: { width, height: width < 600 ? 844 : 900 }, colorScheme: scheme });
      await context.addCookies([{ name: "locale", value: locale, url: "http://localhost:3100" }]);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("console", (m) => m.type() === "error" && !isCancelledPrefetch(m.text()) && errors.push(`${m.text()} (${m.location().url})`));
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(path);
      await expect(page).toHaveURL((url) => url.pathname === new URL(path, "http://localhost:3100").pathname);
      await expect(page.locator("main h1").first()).toBeVisible();
      if (path.startsWith("/leads/")) {
        await appReady(page);
        await expect(page.getByRole("tabpanel").filter({ has: page.locator("input[type=file]") })).toBeVisible();
      }
      if (act) await act(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `${dir}/${name}-${locale}-${scheme}-${width}.png`, fullPage });
      expect(errors, `${name} ${locale} ${scheme} ${width}`).toEqual([]);
      await context.close();
    }
  }
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  mkdirSync(dir, { recursive: true });
  const secret = await createUser(adminEmail, password, true);
  await createUser(repEmail, password, false);
  setRole(adminEmail, "admin");
  sql(`update public.profiles set first_name = 'Clara', last_name = 'Benoît' where id = '${userId(adminEmail)}'`);
  sql(`update public.profiles set first_name = 'Hugo', last_name = 'Lemaire' where id = '${userId(repEmail)}'`);
  const mk = (name: string) =>
    sql(`insert into public.companies (org_id, name, owner_id, lead_status, phone, email, city, country)
         select p.org_id, '${name}', p.id, 'warm', '04 72 00 00 00', 'achats@example.com', 'Lyon', 'FR'
         from public.profiles p where p.id = '${userId(adminEmail)}' returning id`);
  lead = mk("Maison Verdane");
  emptyLead = mk("Halles Corvel");
  const files: [string, string, number, string, string, string][] = [
    ["Devis printemps 2026.pdf", "application/pdf", 1_258_291, adminEmail, "ready", "2 hours"],
    ["Tarifs grossiste — octobre 2026.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 48_128, repEmail, "ready", "1 day"],
    ["Photo vitrine.jpg", "image/jpeg", 3_407_872, repEmail, "ready", "3 days"],
    ["Bon de commande n°7.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 96_256, adminEmail, "ready", "9 days"],
    ["Catalogue complet des références saison automne-hiver avec les prix par carton et les délais de livraison.pdf", "application/pdf", 9_961_472, adminEmail, "ready", "40 days"],
    ["Ancienne fiche produit.pdf", "application/pdf", 310_000, adminEmail, "deleting", "50 days"],
  ];
  for (const [name, mime, size, by, status, ago] of files) {
    sql(`insert into public.files (org_id, company_id, name, mime, size, uploaded_by, status, ready_at, created_at)
         select org_id, id, $q$${name}$q$, '${mime}', ${size}, '${userId(by)}', '${status}', ${status === "ready" ? "now()" : "null"},
                now() - interval '${ago}' from public.companies where id = '${lead}'`);
  }
  state = await fullSession(browser, adminEmail, password, secret);
});

test("files tab: the list at every width, both themes, both languages", async ({ browser }) => {
  await shoot(browser, `/leads/${lead}?tab=files`, "files-list", full);
});

test("files tab: empty, refused uploads, delete confirmation, row menu, unavailable page", async ({ browser }) => {
  await shoot(browser, `/leads/${emptyLead}?tab=files`, "files-empty", pair);
  await shoot(browser, `/leads/${emptyLead}?tab=files`, "files-refused", pair, async (page) => {
    await page.locator("input[type=file]").setInputFiles([
      { name: "catalogue-complet.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(10_485_761, 0x25) },
      { name: "facture.pdf", mimeType: "application/pdf", buffer: Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]) },
      { name: "plan.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") },
    ]);
    await expect(page.getByRole("list").filter({ has: page.locator("[data-upload-key]") }).locator("li")).toHaveCount(3);
    await expect(page.locator("[data-upload-key] .bg-status-red")).toHaveCount(3);
  });
  await shoot(
    browser,
    `/leads/${lead}?tab=files`,
    "files-delete-confirm",
    pair,
    async (page) => {
      await page.locator("[role=tabpanel]:has(input[type=file]) [aria-haspopup=menu]").last().click();
      await page.getByRole("menuitem").last().click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.waitForTimeout(400);
    },
    { fullPage: false },
  );
  await shoot(
    browser,
    `/leads/${lead}?tab=files`,
    "files-menu",
    [{ locale: "en", scheme: "light", widths: [1440] }, { locale: "fr", scheme: "dark", widths: [1440] }],
    async (page) => {
      await page.locator("[role=tabpanel]:has(input[type=file]) [aria-haspopup=menu]").first().click();
      await expect(page.getByRole("menu")).toBeVisible();
      await page.waitForTimeout(300);
    },
    { fullPage: false },
  );
  await shoot(browser, "/files/unavailable", "files-unavailable", pair);
});
