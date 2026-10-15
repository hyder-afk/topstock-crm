import { mkdirSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { appReady, createUser, fullSession, isCancelledPrefetch, setRole, sql } from "./helpers";

// Evidence screenshots of the Files tab (Day 4d, design 7.6): the list at every width in both themes and both
// languages, then the empty state, refused uploads, the delete confirmation, the row menu and the unavailable page,
// then an upload's line while uploading (about 40%), while checking, and after a failed check (verifier 4d round 2
// finding 15).
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

// An upload's line in its three states. The bytes go to a sink in this test (the Storage request is routed there, its
// CORS preflight too) with the upload throttled, so the bar stops part-way for the shot; the finish is held for the
// "Checking the file…" shot, then released: without stored bytes the check cannot read them, so the line ends on
// "Couldn't add this file. Try again." with Try again (and the pending row is cancelled). One context per combination
// takes all three shots, so 8 uploads in all (the hourly limit is 30).
test("files tab: an upload's line while uploading, checking, and after a failed check", async ({ browser }) => {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
  const sink = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      return res.end();
    }
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { ...cors, "content-type": "application/json" });
      res.end(JSON.stringify({ Key: "lead-files/sink", Id: "sink" }));
    });
  });
  await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
  const sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/sink`;
  try {
    for (const { locale, scheme } of full) {
      for (const width of [390, 1440]) {
        // Locally (no storage-api) a cancelled upload's row stays "deleting" (its bytes cannot be removed) and would pile
        // up as "Couldn't finish deleting" rows in the next shots: test-only clean-up of the previous combination's row.
        sql(`delete from public.files where company_id = '${emptyLead}' and status <> 'ready'`);
        const context = await browser.newContext({ storageState: state, viewport: { width, height: width < 600 ? 844 : 900 }, colorScheme: scheme });
        await context.addCookies([{ name: "locale", value: locale, url: "http://localhost:3100" }]);
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("console", (m) => m.type() === "error" && !isCancelledPrefetch(m.text()) && errors.push(`${m.text()} (${m.location().url})`));
        page.on("pageerror", (e) => errors.push(e.message));
        // Any action after the Storage request started is the finish (beginUpload comes before it).
        let storageSent = false;
        await page.route("**/storage/v1/object/lead-files/**", (route) => {
          storageSent = true;
          return route.continue({ url: sinkUrl });
        });
        let finishHeld = false;
        let release!: () => void;
        const released = new Promise<void>((resolve) => (release = resolve));
        await page.route(
          (url) => url.pathname === `/leads/${emptyLead}`,
          async (route) => {
            const r = route.request();
            if (r.method() === "POST" && r.headers()["next-action"] && storageSent && !finishHeld) {
              finishHeld = true;
              await released;
            }
            await route.fallback();
          },
        );
        await page.goto(`/leads/${emptyLead}?tab=files`);
        await expect(page.locator("main h1").first()).toBeVisible();
        await appReady(page);
        const panel = page.getByRole("tabpanel").filter({ has: page.locator("input[type=file]") });
        await expect(panel).toBeVisible();
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.enable");
        await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 160 * 1024 });
        const pdf = Buffer.alloc(3_200_000, 0x20);
        pdf.write("%PDF-1.7\n");
        pdf.write("%%EOF\n", pdf.length - 6);
        await panel.locator("input[type=file]").setInputFiles({ name: "Catalogue printemps 2027.pdf", mimeType: "application/pdf", buffer: pdf });
        const bar = panel.getByRole("progressbar");
        await expect.poll(async () => Number(await bar.getAttribute("aria-valuenow")), { timeout: 60_000 }).toBeGreaterThanOrEqual(35);
        await page.waitForTimeout(300);
        // The viewport with the line in its middle: on phones a full-page shot would put the floating dock over it.
        const shot = async (name: string) => {
          expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
          await panel.locator("[data-upload-key]").evaluate((el) => el.scrollIntoView({ block: "center" }));
          await page.screenshot({ path: `${dir}/${name}-${locale}-${scheme}-${width}.png` });
        };
        await shot("files-uploading");
        await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        await expect(bar).toHaveAttribute("aria-valuetext", locale === "fr" ? "Vérification du fichier…" : "Checking the file…", { timeout: 60_000 });
        await page.waitForTimeout(500);
        await shot("files-checking");
        release();
        await expect(panel.locator("[data-upload-key] .bg-status-red")).toBeVisible({ timeout: 30_000 });
        await page.waitForTimeout(300);
        await shot("files-failed");
        expect(errors, `upload states ${locale} ${scheme} ${width}`).toEqual([]);
        await context.close();
      }
    }
  } finally {
    sink.close();
  }
});
