import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ageStepUp, appReady, createUser, fullSession, nextWindow, seedLeads, setRole, sql, totp } from "./helpers";

// Evidence screenshots of every sign-in screen, signed out and signed in, against a real Supabase Auth server.
// Saved to test-results/screens; CI uploads them as the "auth-screens" artifact, locally they are copied into
// docs/evidence. Each shot waits for the real screen (not the loading skeleton) and checks for console errors and
// sideways scroll first.
test.describe.configure({ mode: "serial", timeout: 600_000 });

const dir = "test-results/screens";
// CLAUDE.md widths: all six for EN light, the desktop set plus phone for FR dark, phone and laptop for the rest.
const matrix = [
  { locale: "en", scheme: "light", widths: [390, 768, 1024, 1280, 1440, 1728] },
  { locale: "fr", scheme: "dark", widths: [390, 1280, 1440, 1728] },
  { locale: "en", scheme: "dark", widths: [390, 1440] },
  { locale: "fr", scheme: "light", widths: [390, 1440] },
] as const;
const password = "Screens-Pass-42!";
const withFactor = `screens-a-${Date.now()}@example.test`;
const noFactor = `screens-b-${Date.now()}@example.test`;
let secret = "";
const states: Record<string, Awaited<ReturnType<BrowserContext["storageState"]>> | undefined> = { none: undefined };

async function signIn(browser: Browser, email: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/mfa/);
  return { context, page };
}

// Placeholder sections share one component: EN light and FR dark at phone and laptop width are enough for them
// (logged waiver, Tooling Protocol section 6 item 9; Leads, the shared template, gets the full matrix).
const lightMatrix = [
  { locale: "en", scheme: "light", widths: [390, 1440] },
  { locale: "fr", scheme: "dark", widths: [390, 1440] },
] as const;

async function shoot(
  browser: Browser,
  state: string,
  path: string,
  name: string,
  act?: (page: Page) => Promise<void>,
  combos: readonly { locale: string; scheme: "light" | "dark"; widths: readonly number[] }[] = matrix,
  before?: () => void,
) {
  for (const { locale, scheme, widths } of combos) {
    for (const width of widths) {
      const context = await browser.newContext({
        storageState: states[state],
        viewport: { width, height: width < 600 ? 844 : 900 },
        colorScheme: scheme,
      });
      await context.addCookies([{ name: "locale", value: locale, url: "http://localhost:3100" }]);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("console", (m) => m.type() === "error" && errors.push(`${m.text()} (${m.location().url})`));
      page.on("pageerror", (e) => errors.push(e.message));
      before?.();
      await page.goto(path);
      // The right page (no unexpected redirect), then the real screen, not the loading skeleton (which has no heading).
      await expect(page).toHaveURL((url) => url.pathname === new URL(path, "http://localhost:3100").pathname);
      await expect(page.locator("main h1").first()).toBeVisible();
      if (act) await act(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `${dir}/${name}-${locale}-${scheme}-${width}.png`, fullPage: true });
      expect(errors, `${name} ${locale} ${scheme} ${width}`).toEqual([]);
      await context.close();
    }
  }
}

test.beforeAll(async ({ browser }) => {
  mkdirSync(dir, { recursive: true });
  secret = await createUser(withFactor, password, true);
  await createUser(noFactor, password, false);
  // Made-up leads for the leads screens, owned by the signed-in screenshot user (an admin named Inès Garnier).
  setRole(withFactor, "admin");
  sql(`update public.profiles set first_name = 'Inès', last_name = 'Garnier'
       where id = (select id from auth.users where email = '${withFactor}')`);
  seedLeads([withFactor]);

  const b = await signIn(browser, noFactor);
  states.setup = await b.context.storageState();
  await b.context.close();

  const a = await signIn(browser, withFactor);
  states.verify = await a.context.storageState();
  await nextWindow();
  await a.page.getByLabel("6-digit code").fill(totp(secret));
  await a.page.getByRole("button", { name: "Verify" }).click();
  await expect(a.page).toHaveURL(/\/$/);
  states.full = await a.context.storageState();
  await a.context.close();
});

test("signed out: sign in, wrong password, forgot, link landing", async ({ browser }) => {
  await shoot(browser, "none", "/login", "login");
  await shoot(browser, "none", "/login", "login-error", async (page) => {
    await page.locator("input[name=email]").fill("nobody@example.test");
    await page.locator("input[name=password]").fill("Wrong-Password-1!");
    await page.locator("button[type=submit]").click();
    await expect(page.getByRole("main").getByRole("alert")).not.toBeEmpty();
  });
  await shoot(browser, "none", "/forgot-password", "forgot");
  await shoot(browser, "none", "/forgot-password", "forgot-done", async (page) => {
    await page.locator("input[name=email]").fill("nobody@example.test");
    await page.locator("button[type=submit]").click();
    await expect(page.getByRole("main").getByRole("status")).not.toBeEmpty();
  });
  await shoot(browser, "none", "/auth/confirm?token_hash=fake&type=invite", "confirm-invite");
});

test("two-factor setup (QR shown)", async ({ browser }) => {
  await shoot(browser, "setup", "/mfa/setup", "mfa-setup", async (page) => {
    await page.getByRole("button", { name: /Show QR code|Afficher le QR code/ }).click();
    await expect(page.locator("img[src^='data:']")).toBeVisible();
  });
});

test("choose a password", async ({ browser }) => {
  await shoot(browser, "setup", "/set-password", "set-password");
});

test("enter your code", async ({ browser }) => {
  await shoot(browser, "verify", "/mfa", "mfa");
});

test("home, signed in", async ({ browser }) => {
  await shoot(browser, "full", "/", "home");
});

test("app shell: leads and more in full, the other sections in brief", async ({ browser }) => {
  await shoot(browser, "full", "/leads", "leads");
  await shoot(browser, "full", "/more", "more");
  for (const section of ["pipeline", "inventory", "tasks", "analytics"]) {
    await shoot(browser, "full", `/${section}`, section, undefined, lightMatrix);
  }
});

test("leads: list with a lead open, add a lead, filters", async ({ browser }) => {
  const first = sql(`select id from public.companies
                     order by coalesce(last_activity_at, '-infinity'::timestamptz) desc, id desc limit 1`);
  await shoot(browser, "full", `/leads?lead=${first}`, "leads-preview", async (page) => {
    await expect(page.locator("aside h2")).toBeVisible();
  });
  await shoot(browser, "full", "/leads", "leads-add", async (page) => {
    await appReady(page);
    await page.getByRole("button", { name: /^(Add lead|Ajouter un prospect)$/ }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.waitForTimeout(250);
  });
  await shoot(browser, "full", "/leads", "leads-filters", async (page) => {
    await appReady(page);
    await page.getByRole("button", { name: /^(Filters|Filtres)/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.waitForTimeout(250);
  });
});

test("command menu and shortcuts list", async ({ browser }) => {
  await shoot(browser, "full", "/", "palette", async (page) => {
    await appReady(page);
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.waitForTimeout(250); // let the entrance settle before the shot
  });
  await shoot(
    browser,
    "full",
    "/",
    "shortcuts",
    async (page) => {
      await appReady(page);
      await page.keyboard.press("Shift+Slash");
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.waitForTimeout(250);
    },
  );
});

// Lead import (Day 3b). The owners named in the sample files are people in this team, so the owner matching looks
// real, and existing-20.csv is imported once so the 500-row sample shows leads already in the CRM. Every shot does
// its own steps from a clean slate (unfinished and discarded imports removed; at most 3 may be open). The "Confirm it's you" shots use a
// session whose code was made to look 15 minutes old.
test("lead import: choose, match, results, undo, confirm it's you, done", async ({ browser }) => {
  test.setTimeout(1_500_000);
  sql(`delete from public.import_batches;
       update public.profiles set last_name = 'Earlier run'
       where last_name = 'Test' and first_name in ('Haider', 'Henri', 'Kais')`);
  for (const first of ["Haider", "Henri", "Kais"]) {
    const email = `screens-${first.toLowerCase()}-${Date.now()}@example.test`;
    await createUser(email, password, false);
    sql(`update public.profiles set first_name = '${first}', last_name = 'Test'
         where id = (select id from auth.users where email = '${email}')`);
  }
  // Each import step needs a code from the last 10 minutes (the screen asks again with fewer than 3 left).
  let signedAt = 0;
  const fresh = async () => {
    if (Date.now() - signedAt < 120_000) return;
    states.importer = await fullSession(browser, withFactor, password, secret);
    signedAt = Date.now();
  };
  const fixture = (name: string) => path.join(__dirname, "..", "fixtures", "import", name);
  // Runs before each page load.
  const clean = () => {
    sql(`delete from public.companies where name like 'Reprise %';
         delete from public.import_batches where filename = 'reprise-5.csv';
         delete from public.import_batches where status in ('staged', 'dry_run', 'discarded')`);
  };
  const heading = (page: Page, text: RegExp) => expect(page.locator("#import-step-heading")).toHaveText(text);
  const pick = async (page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }) => {
    await appReady(page);
    await page.locator('input[type="file"]').setInputFiles(typeof file === "string" ? fixture(file) : file);
    await heading(page, /^(Match your columns|Associez vos colonnes)$/);
  };
  const checkFile = async (page: Page) => {
    // Status words with no obvious meaning ("Hot lead", "Prospect") get a choice first.
    for (const status of ["warm", "cold"]) {
      const open = page.locator('select[aria-invalid="true"]').first();
      if (await open.count()) await open.selectOption(status);
    }
    await page.getByRole("button", { name: /^(Check file|Vérifier le fichier)/ }).click();
  };
  const results = async (page: Page) => {
    await heading(page, /^(Check results|Résultat de la vérification)$/);
    await expect(page.locator("dl > div")).toHaveCount(4);
  };

  await fresh();
  {
    const context = await browser.newContext({ storageState: states.importer, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto("/leads/import");
    await pick(page, "existing-20.csv");
    await checkFile(page);
    await results(page);
    await page.getByRole("button", { name: /^Import 20 leads/ }).click();
    await heading(page, /^20 leads added$/);
    await context.close();
  }

  await shoot(browser, "importer", "/leads/import", "import-choose", async (page) => {
    await heading(page, /^(Choose your file|Choisissez votre fichier)$/);
    await expect(page.getByRole("complementary").getByRole("listitem")).toHaveCount(1);
  }, matrix, clean);
  await fresh();
  await shoot(browser, "importer", "/leads/import", "import-match", async (page) => {
    await pick(page, "leads-500-fake.csv");
  }, matrix, clean);
  await fresh();
  await shoot(browser, "importer", "/leads/import", "import-results", async (page) => {
    await pick(page, "leads-500-fake.csv");
    await checkFile(page);
    await results(page);
    await expect(page.getByRole("listitem").filter({ hasText: /^13/ }).first()).toBeVisible();
  }, matrix, clean);
  await fresh();
  await shoot(browser, "importer", "/leads/import", "import-undo", async (page) => {
    await appReady(page);
    const item = page.getByRole("complementary").getByRole("listitem").filter({ hasText: "existing-20.csv" });
    await item.getByRole("button", { name: /^(Undo import|Annuler l’import)$/ }).click();
    await expect(page.getByRole("dialog").getByRole("button")).toHaveCount(2);
    await page.waitForTimeout(250);
  }, matrix, clean);
  await fresh();
  const reprise = {
    name: "reprise-5.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      ["Société,Ville,Pays,Courriel", ...["Alpha", "Brio", "Cendre", "Dune", "Écume"].map((n, i) => `Reprise ${n},Lyon,France,reprise${i}@example.test`)].join("\r\n"),
    ),
  };
  await shoot(browser, "importer", "/leads/import", "import-done", async (page) => {
    await pick(page, reprise);
    await checkFile(page);
    await results(page);
    await page.getByRole("button", { name: /^(Import 5 leads|Importer 5 prospects)/ }).click();
    await heading(page, /^(5 leads added|5 prospects ajoutés)$/);
    // Past imports refreshes right after: wait for it to show the import as done.
    await expect(page.getByRole("complementary").getByRole("listitem").first()).toContainText(/Imported|Importé/);
  }, matrix, clean);
  clean();

  // Last: back-dating the code rotates this session.
  {
    const context = await browser.newContext({ storageState: states.importer });
    await ageStepUp(context, 900);
    states.stale = await context.storageState();
    await context.close();
  }
  await shoot(browser, "stale", "/leads/import", "import-step-up", async (page) => {
    await pick(page, "existing-20.csv");
    await page.getByRole("button", { name: /^(Check file|Vérifier le fichier)/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.waitForTimeout(250);
  }, matrix, clean);
  clean();
});

