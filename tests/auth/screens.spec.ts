import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ageStepUp, appReady, choose, countryInHours, createUser, fullSession, nextWindow, seedLeads, setRole, sql, totp } from "./helpers";

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
  before?: (page: Page) => void | Promise<void>,
  // fullPage false: the viewport only, so layers fixed to the screen (the call panel, sheets) show where they sit.
  { fullPage = true }: { fullPage?: boolean } = {},
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
      await before?.(page);
      await page.goto(path);
      // The right page (no unexpected redirect), then the real screen, not the loading skeleton (which has no heading).
      await expect(page).toHaveURL((url) => url.pathname === new URL(path, "http://localhost:3100").pathname);
      await expect(page.locator("main h1").first()).toBeVisible();
      if (act) await act(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `${dir}/${name}-${locale}-${scheme}-${width}.png`, fullPage });
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
  for (const section of ["pipeline", "inventory", "analytics"]) {
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

// The lead page (Day 4b): every width in both themes and both languages for the main view; the timeline, the call panel
// with the outcome pad, Details, "Until when?" and a Do not contact lead on the usual matrix. A made-up lead with
// contacts (one number marked wrong), one entry of each kind, an open follow-up task and a next call date.
const fullMatrix = [
  { locale: "en", scheme: "light", widths: [390, 768, 1024, 1280, 1440, 1728] },
  { locale: "en", scheme: "dark", widths: [390, 768, 1024, 1280, 1440, 1728] },
  { locale: "fr", scheme: "light", widths: [390, 768, 1024, 1280, 1440, 1728] },
  { locale: "fr", scheme: "dark", widths: [390, 768, 1024, 1280, 1440, 1728] },
] as const;

test("lead page: summary, timeline, call panel, details, until when, do not contact, calling hours", async ({ browser }) => {
  test.setTimeout(1_500_000);
  const me = sql(`select id from auth.users where email = '${withFactor}'`);
  const lead = sql(`insert into public.companies (org_id, name, owner_id, lead_status, phone, email, city, country)
                    select org_id, 'Maison Verdane', id, 'warm', '04 78 12 34 56', 'achats@verdane.example.com', 'Lyon', 'FR'
                    from public.profiles where id = '${me}' returning id`);
  sql(`insert into public.contacts (org_id, company_id, first_name, last_name, title, email, phone)
       select org_id, id, 'Amélie', 'Laurent', 'Head buyer', 'amelie@verdane.example.com', '06 12 34 56 78' from public.companies where id = '${lead}';
       insert into public.contacts (org_id, company_id, first_name, last_name, title, email, phone)
       select org_id, id, 'Karim', 'Benali', 'Owner', null, '06 98 76 54 32' from public.companies where id = '${lead}';
       update public.contacts set phone_wrong_at = now() - interval '2 days' where first_name = 'Karim' and company_id = '${lead}';
       insert into public.activities (org_id, company_id, user_id, type, outcome, body, created_at)
       select c.org_id, c.id, '${me}', v.type, v.outcome, v.body, now() - v.ago
       from public.companies c, (values
         ('call', 'no_answer', null, interval '3 days 2 hours'),
         ('email', 'sent', 'Subject: Spring price list' || chr(10) || chr(10) || 'Bonjour Amélie, voici les prix du lot denim grade A.', interval '2 days 5 hours'),
         ('whatsapp', 'sent', 'Photos of the denim lot sent.', interval '1 day 6 hours'),
         ('call', 'interested', 'Wants 300 pieces of denim jackets, grade A. Call back with the container date.', interval '1 day 2 hours'),
         ('meeting', 'held', 'Visited the showroom in Lyon. Next: samples.', interval '5 hours'),
         ('note', null, 'Prefers WhatsApp in the morning. Pays by transfer, 30 days.', interval '20 minutes')
       ) as v (type, outcome, body, ago) where c.id = '${lead}';
       insert into public.tasks (org_id, company_id, title, kind, due_date, assignee_id)
       select org_id, id, 'Follow up with Maison Verdane', 'call', (now() at time zone 'Europe/Paris')::date + 1, '${me}'
       from public.companies where id = '${lead}';
       update public.companies set next_action_at = now() + interval '1 day 2 hours' where id = '${lead}';`);
  const dnc = sql(`insert into public.companies (org_id, name, owner_id, lead_status, phone, email, city, country)
                   select org_id, 'Comptoir Silence', id, 'do_not_contact', '01 23 45 67 89', 'contact@silence.example.com', 'Paris', 'FR'
                   from public.profiles where id = '${me}' returning id`);
  // Timeline rows use content-visibility: auto (design D13), which skips painting rows far outside the viewport; a
  // full-page shot captures them, so they are painted for the shot only.
  const ready = async (page: Page) => {
    await appReady(page);
    await page.addStyleTag({ content: "li[style*='content-visibility'] { content-visibility: visible !important; }" });
    await page.waitForTimeout(300);
  };
  await shoot(browser, "full", `/leads/${lead}`, "lead", async (page) => {
    await ready(page);
    await expect(page.getByRole("tabpanel").getByRole("article").first()).toBeVisible();
  }, fullMatrix);
  await shoot(browser, "full", `/leads/${lead}?tab=timeline`, "lead-timeline", async (page) => {
    await ready(page);
    await expect(page.getByRole("tabpanel").getByRole("article")).toHaveCount(6);
  });
  await shoot(browser, "full", `/leads/${lead}`, "lead-call", async (page) => {
    await ready(page);
    // Start the call from the Call action without leaving the page (tel: has no handler in a test browser).
    await page.evaluate(() => {
      const a = document.querySelector<HTMLAnchorElement>("main a[href^='tel:']");
      a?.addEventListener("click", (e) => e.preventDefault(), { once: true });
      a?.click();
    });
    const panel = page.getByRole("region", { name: /^(Calling|Appel vers)/ });
    await panel.getByRole("button", { name: /^(End call|Raccrocher)$/ }).click();
    await page.keyboard.press("Digit5");
    await expect(panel.locator('[data-outcome="interested"]')).toHaveAttribute("aria-pressed", "true");
    await page.waitForTimeout(500);
  });
  await shoot(browser, "full", `/leads/${lead}?tab=details`, "lead-details", async (page) => {
    await ready(page);
  });
  await shoot(browser, "full", `/leads/${lead}`, "lead-until", async (page) => {
    await ready(page);
    await page.getByRole("button", { name: /^(Status|Statut)/ }).click();
    await page.getByRole("menuitemradio", { name: /^(Cool off|En pause)$/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.waitForTimeout(400);
    // Viewport shots: a full-page capture of a page taller than the screen paints an open dialog half transparent
    // (a capture artefact; the dialog is opaque on screen).
  }, matrix, undefined, { fullPage: false });
  // Review round (Day 4b findings 12, 13, 18, 22 and the call panel's second Call): Do not contact at 768 too, where only
  // "Add a note" can log; its sheet offers Note, Call and Meeting (no Email or WhatsApp).
  const dncMatrix = [
    { locale: "en", scheme: "light", widths: [390, 768, 1440] },
    { locale: "fr", scheme: "dark", widths: [390, 768, 1440] },
  ] as const;
  await shoot(browser, "full", `/leads/${dnc}`, "lead-dnc", async (page) => {
    await ready(page);
    await expect(page.getByRole("note")).toBeVisible();
  }, dncMatrix);
  await shoot(browser, "full", `/leads/${dnc}`, "lead-dnc-note", async (page) => {
    await ready(page);
    await page.getByRole("button", { name: /^(Add a note|Ajouter une note)$/ }).click();
    const sheet = page.getByRole("dialog", { name: /^(Log activity|Noter une activité)$/ });
    await expect(sheet.getByRole("group", { name: /^(Kind of entry|Type d’entrée)$/ }).getByRole("button")).toHaveCount(3);
    await expect(sheet.getByRole("button", { name: /^(Email|E-mail|WhatsApp)$/ })).toHaveCount(0);
    await page.waitForTimeout(400); // phone sheets rise in 320 ms
  }, [
    { locale: "en", scheme: "light", widths: [390, 768] },
    { locale: "fr", scheme: "dark", widths: [390, 768] },
  ], undefined, { fullPage: false });
  // A second Call while the first call's outcome step is open: the first keeps its outcome and the second waits, named
  // in the panel's status line. Viewport shots, so the phone sheet sits at the bottom where it is on a phone.
  await shoot(browser, "full", `/leads/${lead}`, "lead-call-queued", async (page) => {
    await ready(page);
    await page.evaluate(() => {
      const links = [...document.querySelectorAll<HTMLAnchorElement>("main a[href^='tel:']")].filter((a) => a.getClientRects().length > 0);
      const first = links[0];
      first?.addEventListener("click", (e) => e.preventDefault(), { once: true });
      first?.click();
    });
    const panel = page.getByRole("region", { name: /^(Calling|Appel vers)/ });
    await panel.getByRole("button", { name: /^(End call|Raccrocher)$/ }).click();
    await page.keyboard.press("Digit2");
    await page.evaluate(() => {
      const links = [...document.querySelectorAll<HTMLAnchorElement>("main a[href^='tel:']")];
      const other = links.find((a) => a.getClientRects().length > 0 && a.getAttribute("href") !== links[0]?.getAttribute("href"));
      other?.addEventListener("click", (e) => e.preventDefault(), { once: true });
      other?.click();
    });
    await expect(panel.getByRole("status").first()).toHaveText(/^(Finish logging this call first|Finissez d’abord de noter cet appel)/);
    await page.waitForTimeout(500);
  }, lightMatrix, undefined, { fullPage: false });
  // Calling hours that open another day, clock fixed to Saturday 10 Oct 2026 12:00 UTC (14:00 in Lyon, closed until
  // Monday 09:00): French "ouvre lun. à 09:00", English "opens Mon 09:00". A lead with no entries, so no time on the page
  // is later than the fixed clock.
  const hours = sql(`insert into public.companies (org_id, name, owner_id, lead_status, phone, city, country)
                     select org_id, 'Mercerie du Samedi', id, 'warm', '04 72 00 11 22', 'Lyon', 'FR'
                     from public.profiles where id = '${me}' returning id`);
  await shoot(browser, "full", `/leads/${hours}`, "lead-hours", async (page) => {
    await ready(page);
    await expect(page.getByText(/(ouvre lun\. à 09:00|opens Mon 09:00) \((dans|in) /)).toBeVisible();
  }, [
    { locale: "fr", scheme: "light", widths: [390, 1440] },
    { locale: "fr", scheme: "dark", widths: [390, 1440] },
    { locale: "en", scheme: "light", widths: [1440] },
  ], (page) => page.clock.setFixedTime(new Date("2026-10-10T12:00:00Z")));
});

// The lead page's route skeleton (loading.tsx) at 1024, where the actions sit under the header, and 1280, where they sit
// beside it (finding 18: the skeleton matches the page block for block). Opened from the leads preview with O; the page's
// own data request is held back while the shot is taken (prefetches pass), then let through.
test("lead page: route skeleton at 1024 and 1280", async ({ browser }) => {
  const id = sql(`select id from public.companies where name = 'Maison Verdane' order by created_at desc limit 1`);
  for (const { locale, scheme } of [
    { locale: "en", scheme: "light" },
    { locale: "fr", scheme: "dark" },
  ] as const) {
    for (const width of [1024, 1280]) {
      const context = await browser.newContext({ storageState: states.full, viewport: { width, height: 900 }, colorScheme: scheme });
      await context.addCookies([{ name: "locale", value: locale, url: "http://localhost:3100" }]);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("console", (m) => m.type() === "error" && errors.push(`${m.text()} (${m.location().url})`));
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`/leads?lead=${id}`);
      await appReady(page);
      await expect(page.locator("aside h2")).toBeVisible();
      await page.waitForLoadState("networkidle");
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      await page.route(new RegExp(`/leads/${id}(\\?|$)`), async (route) => {
        const headers = route.request().headers();
        if (headers.rsc && !headers["next-router-prefetch"]) await held;
        await route.continue();
      });
      await page.keyboard.press("o");
      await expect(page).toHaveURL(new RegExp(`/leads/${id}$`));
      await expect(page.locator("main [aria-busy=true]")).toBeVisible();
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `${dir}/lead-skeleton-${locale}-${scheme}-${width}.png` });
      release();
      await expect(page.locator("main h1").first()).toBeVisible();
      await appReady(page);
      expect(errors, `lead-skeleton ${locale} ${scheme} ${width}`).toEqual([]);
      await context.close();
    }
  }
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
test("lead import: choose, match, results, undo, done, discard, confirm it's you", async ({ browser }) => {
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
      const open = page.locator('[role="combobox"][aria-invalid="true"]').first();
      if (await open.count()) await choose(open, status);
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
  // Every choice made: the live counts line under Check file.
  await shoot(browser, "importer", "/leads/import", "import-match-ready", async (page) => {
    await pick(page, "leads-500-fake.csv");
    for (const status of ["warm", "cold"]) {
      const open = page.locator('[role="combobox"][aria-invalid="true"]').first();
      if (await open.count()) await choose(open, status);
    }
    await expect(page.getByRole("status").filter({ hasText: /^450 / })).toBeVisible();
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
    await page.waitForTimeout(400); // phone sheets rise in 320 ms
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
  await fresh();
  await shoot(browser, "importer", "/leads/import", "import-discard", async (page) => {
    await pick(page, "existing-20.csv");
    await checkFile(page);
    await results(page);
    await page.getByRole("button", { name: /^(Discard|Abandonner)$/ }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.waitForTimeout(400);
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
    await page.waitForTimeout(400); // phone sheets rise in 320 ms
  }, matrix, clean);
  clean();
});



// Day 4c: the Tasks page, the work queue and the lead page's "on this lead" line, at every width in both themes and both
// languages for the main views, the usual matrix for the states; then the two route skeletons. The screenshot user (an
// admin, Inès Garnier, zone Europe/Paris) gets made-up tasks and leads; calling hours follow the real clock, so the
// queue's leads are in a country in hours now (or the shots use "Show leads outside calling hours").
test("tasks page: today with rows, overdue, inline edit, delete question, team", async ({ browser }) => {
  test.setTimeout(1_500_000);
  const me = sql(`select id from auth.users where email = '${withFactor}'`);
  sql(`update public.profiles set timezone = 'Europe/Paris' where id = '${me}'`);
  const lead = sql(`insert into public.companies (org_id, name, owner_id, lead_status, phone, city, country)
                    select org_id, 'Maison Tâches', id, 'warm', '04 78 00 00 01', 'Lyon', 'FR' from public.profiles where id = '${me}' returning id`);
  const dnc = sql(`insert into public.companies (org_id, name, owner_id, lead_status, phone, city, country)
                   select org_id, 'Comptoir Silence Tâches', id, 'do_not_contact', '01 23 45 67 00', 'Paris', 'FR' from public.profiles where id = '${me}' returning id`);
  const gb = sql(`insert into public.companies (org_id, name, owner_id, lead_status, phone, city, country)
                  select org_id, 'Brixton Textiles Tâches', id, 'cold', '07700 900124', 'London', 'GB' from public.profiles where id = '${me}' returning id`);
  sql(`update public.tasks set cancelled_at = now() where assignee_id = '${me}' and done_at is null and cancelled_at is null;
       insert into public.tasks (org_id, company_id, title, kind, due_date, due_at, assignee_id, created_by)
       select p.org_id, v.company, v.title, v.kind, v.due_date, v.due_at, p.id, p.id
       from public.profiles p, (values
         ('${lead}'::uuid, 'Send the spring price list', 'todo', (now() at time zone 'Europe/Paris')::date, null::timestamptz),
         ('${gb}'::uuid, 'Call back about the denim lot', 'call', null::date, date_trunc('day', now() at time zone 'Europe/Paris') at time zone 'Europe/Paris' + interval '23 hours 30 minutes'),
         (null::uuid, 'Renew the warehouse insurance', 'todo', (now() at time zone 'Europe/Paris')::date, null::timestamptz),
         ('${dnc}'::uuid, 'Close the account', 'todo', (now() at time zone 'Europe/Paris')::date, null::timestamptz),
         ('${lead}'::uuid, 'Chase the unpaid invoice', 'todo', (now() at time zone 'Europe/Paris')::date - 2, null::timestamptz),
         ('${lead}'::uuid, 'Showroom visit with Amélie', 'meeting', null::date, now() + interval '3 days'),
         (null::uuid, 'Plan the summer catalogue', 'todo', null::date, null::timestamptz)
       ) as v (company, title, kind, due_date, due_at)
       where p.id = '${me}';`);
  const rows = async (page: Page) => {
    await appReady(page);
    await expect(page.getByRole("tabpanel").getByRole("listitem").first()).toBeVisible();
    await page.waitForTimeout(250);
  };
  await shoot(browser, "full", "/tasks", "tasks", rows, fullMatrix);
  await shoot(browser, "full", "/tasks?tab=overdue", "tasks-overdue", rows);
  await shoot(browser, "full", "/tasks?tab=upcoming", "tasks-upcoming", rows, lightMatrix);
  await shoot(browser, "full", "/tasks?tab=done", "tasks-done-empty", async (page) => {
    await appReady(page);
    await expect(page.getByRole("tabpanel").getByText(/^(Nothing done yet\.|Rien de terminé pour l’instant\.)$/)).toBeVisible();
  }, lightMatrix);
  await shoot(browser, "full", "/tasks", "tasks-edit", async (page) => {
    await rows(page);
    await page.locator("[data-task-check]").first().focus();
    await page.keyboard.press("e");
    await expect(page.getByRole("form", { name: /^(Edit task|Modifier la tâche)$/ })).toBeVisible();
    await page.waitForTimeout(250);
  });
  await shoot(browser, "full", "/tasks", "tasks-delete", async (page) => {
    await rows(page);
    await page.locator("[data-task-check]").first().focus();
    await page.keyboard.press("Backspace");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.waitForTimeout(400);
  }, matrix, undefined, { fullPage: false });
  await shoot(browser, "full", "/tasks?scope=team", "tasks-team", rows, lightMatrix);
});

test("work queue: start screen, a card, a follow-up open, the claims ended, no leads of one's own", async ({ browser }) => {
  test.setTimeout(1_500_000);
  const me = sql(`select id from auth.users where email = '${withFactor}'`);
  const open = countryInHours(true, 60);
  // A city that belongs to the country picked for calling hours (the shots read naturally).
  const city = ({ FR: "Lyon", GB: "London", DE: "Köln", PT: "Porto", GR: "Athens", AE: "Dubai", PK: "Karachi", IN: "Mumbai", TH: "Bangkok", JP: "Osaka", NZ: "Auckland", IS: "Reykjavík", AR: "Rosario", CO: "Medellín", CR: "San José", JM: "Kingston", SN: "Dakar", MA: "Casablanca", EG: "Cairo", SA: "Riyadh" } as Record<string, string>)[open ?? "FR"] ?? "Lyon";
  sql(`update public.companies set lead_status = 'disqualified' where owner_id = '${me}' and name like 'File %';
       delete from private.queue_claims where user_id = '${me}';`);
  // The person's other leads wait (next call in 30 days) while the shots are taken, whatever the clock, so the card is
  // always this test's lead; their dates are put back at the end.
  const parked = sql(`with old as (select id, next_action_at from public.companies
                                    where owner_id = '${me}' and name not like 'File %' and queue_rank is not null for update)
                      update public.companies c set next_action_at = now() + interval '30 days' from old where c.id = old.id
                      returning old.id || '|' || coalesce(old.next_action_at::text, '')`)
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("|"));
  const lead = sql(`insert into public.companies (org_id, name, owner_id, lead_status, phone, email, city, country, last_activity_at)
                    select org_id, 'File Maison Verdane', id, 'warm', '+33 4 78 12 34 56', 'achats@verdane.example.com', '${city}', '${open ?? "FR"}', now() - interval '3 days'
                    from public.profiles where id = '${me}' returning id`);
  sql(`insert into public.contacts (org_id, company_id, first_name, last_name, title, email, phone)
       select org_id, id, 'Amélie', 'Laurent', 'Head buyer', 'amelie@verdane.example.com', '+33 6 12 34 56 78' from public.companies where id = '${lead}';
       insert into public.activities (org_id, company_id, user_id, type, outcome, body, created_at)
       select c.org_id, c.id, '${me}', v.type, v.outcome, v.body, now() - v.ago
       from public.companies c, (values
         ('call', 'no_answer', null, interval '3 days'),
         ('note', null, 'Prefers WhatsApp in the morning. Pays by transfer, 30 days.', interval '2 days'),
         ('call', 'interested', 'Wants 300 denim jackets, grade A. Call back with the container date.', interval '1 day')
       ) as v (type, outcome, body, ago) where c.id = '${lead}';
       insert into public.companies (org_id, name, owner_id, lead_status, phone, city, country)
       select p.org_id, 'File Durand SARL ' || i, p.id, 'cold', '+33 4 72 00 00 0' || i, '${city}', '${open ?? "FR"}' from public.profiles p, generate_series(1, 4) i where p.id = '${me}';`);
  const startQueue = async (page: Page) => {
    await appReady(page);
    await page.getByRole("button", { name: /^(Start|Commencer)/ }).click();
    if (!open) await page.getByRole("button", { name: /^(Show leads outside calling hours|Afficher les prospects hors des heures d’appel)$/ }).click();
    await expect(page.locator("main section[role=region]:not([data-leaving]) h2")).toBeVisible();
    await page.waitForTimeout(400);
  };
  await shoot(browser, "full", "/leads/queue", "queue-start", async (page) => {
    await appReady(page);
    await expect(page.getByText(/(to call now|à appeler maintenant)/)).toBeVisible();
  }, fullMatrix);
  await shoot(browser, "full", "/leads/queue", "queue-card", startQueue, fullMatrix);
  await shoot(browser, "full", "/leads/queue", "queue-followup", async (page) => {
    await startQueue(page);
    await page.keyboard.press("Digit5");
    await expect(page.getByRole("group", { name: /^(Follow-up|Relance)$/ })).toBeVisible();
    await page.waitForTimeout(300);
  });
  // The follow-up as the screen shows it once Interested is tapped (viewport shots): on phones it comes into view above
  // the dock, with Confirm in reach.
  await shoot(browser, "full", "/leads/queue", "queue-followup-view", async (page) => {
    await startQueue(page);
    await page.locator('button[data-outcome="interested"]').click();
    await expect(page.getByRole("button", { name: /^(Confirm|Confirmer)$/ })).toBeInViewport();
    await page.waitForTimeout(600);
  }, lightMatrix, undefined, { fullPage: false });
  // An outcome an earlier visit could not save: said in the header on the start screen too (every phase), with Retry.
  await shoot(browser, "full", "/leads/queue", "queue-not-saved", async (page) => {
    await appReady(page);
    await expect(page.getByText(/^(1 outcome not saved|1 résultat non enregistré)$/)).toBeVisible();
  }, lightMatrix, async (page) => {
    await page.addInitScript((leadId) => {
      window.sessionStorage.setItem(
        "topstock.queue.pending",
        JSON.stringify([{ input: { requestId: "6f1c1d2e-3b4a-4c5d-8e9f-0a1b2c3d4e5f", leadId, type: "call", outcome: "no_answer", body: "", contactId: null, dialled: "lead", followUpDate: null, followUpAt: null, leadName: "File Maison Verdane" }, leadName: "File Maison Verdane", at: Date.now() }]),
      );
    }, lead);
  });
  // The claims ended (10 minutes without a key or a click: the page's own clock moves on, the database's claims are
  // ended to match): the start screen says the leads went back to the team, with a link to log a call made meanwhile.
  await shoot(browser, "full", "/leads/queue", "queue-released", async (page) => {
    await startQueue(page);
    sql(`update private.queue_claims set expires_at = now() - interval '1 second' where user_id = '${me}'`);
    await page.clock.fastForward("10:30");
    await expect(page.getByText(/^(Your leads went back to the team|Vos prospects sont retournés à l’équipe)$/)).toBeVisible();
    await page.waitForTimeout(300);
  }, lightMatrix, (page) => page.clock.install());
  // A second admin with no leads of their own: "No leads are assigned to you" with "Work unassigned leads".
  const empty = `screens-q-${Date.now()}@example.test`;
  const emptySecret = await createUser(empty, password, true);
  setRole(empty, "admin");
  states.queueEmpty = await fullSession(browser, empty, password, emptySecret);
  await shoot(browser, "queueEmpty", "/leads/queue", "queue-none-mine", async (page) => {
    await appReady(page);
    await page.getByRole("button", { name: /^(Start|Commencer)/ }).click();
    await expect(page.getByRole("heading", { name: /^(No leads are assigned to you\.|Aucun prospect ne vous est attribué\.)$/ })).toBeVisible();
  }, lightMatrix);
  sql(`delete from private.queue_claims where user_id = '${me}'`);
  for (const [id, at] of parked) sql(`update public.companies set next_action_at = ${at ? `'${at}'` : "null"} where id = '${id}'`);
});

test("lead page: a teammate on this lead in the queue", async ({ browser }) => {
  const me = sql(`select id from auth.users where email = '${withFactor}'`);
  const mate = `screens-mate-${Date.now()}@example.test`;
  await createUser(mate, password, false);
  sql(`update public.profiles set first_name = 'Henri', last_name = 'Test' where id = (select id from auth.users where email = '${mate}')`);
  const lead = sql(`insert into public.companies (org_id, name, owner_id, lead_status, phone, city, country)
                    select org_id, 'Atelier Occupé', id, 'warm', '04 78 99 00 11', 'Lyon', 'FR' from public.profiles where id = '${me}' returning id`);
  // A live claim by the teammate (written as the database owner, so the claim guard leaves its fields as given).
  sql(`insert into private.queue_claims (company_id, org_id, user_id, claimed_at, expires_at)
       select '${lead}', org_id, id, now(), now() + interval '9 minutes' from public.profiles where id = (select id from auth.users where email = '${mate}')`);
  await shoot(browser, "full", `/leads/${lead}`, "lead-worked-by", async (page) => {
    await appReady(page);
    await expect(page.getByText(/(Henri is on this lead in the queue|Henri travaille ce prospect dans la file d’appels)/)).toBeVisible();
  }, lightMatrix);
  sql(`delete from private.queue_claims where company_id = '${lead}'`);
});

// The route skeletons (loading.tsx) of the Tasks page and the queue, block for block with the real pages: opened from the
// app (the dock's Tasks at desktop width; the leads screen's Work queue), the page's own data request held back while the
// shot is taken (prefetches pass), then let through.
test("tasks, queue and more: route skeletons", async ({ browser }) => {
  for (const { locale, scheme } of [
    { locale: "en", scheme: "light" },
    { locale: "fr", scheme: "dark" },
  ] as const) {
    for (const { route, from, link, width } of [
      { route: "tasks", from: "/more", link: /^(Tasks|Tâches)$/, width: 1440 },
      { route: "tasks", from: "/more", link: /^(Tasks|Tâches)$/, width: 1024 },
      { route: "leads/queue", from: "/leads", link: /^(Work queue|File d’appels)$/, width: 1440 },
      { route: "leads/queue", from: "/leads", link: /^(Work queue|File d’appels)$/, width: 390 },
      // More gained "Your time zone" in Day 4c (its skeleton too).
      { route: "more", from: "/leads", link: /^(More|Plus)$/, width: 1440 },
      { route: "more", from: "/leads", link: /^(More|Plus)$/, width: 390 },
    ]) {
      const context = await browser.newContext({ storageState: states.full, viewport: { width, height: width < 600 ? 844 : 900 }, colorScheme: scheme });
      await context.addCookies([{ name: "locale", value: locale, url: "http://localhost:3100" }]);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("console", (m) => m.type() === "error" && errors.push(`${m.text()} (${m.location().url})`));
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(from);
      await appReady(page);
      await page.waitForLoadState("networkidle");
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      await page.route(new RegExp(`/${route}(\\?|$)`), async (r) => {
        const headers = r.request().headers();
        if (headers.rsc && !headers["next-router-prefetch"]) await held;
        await r.continue();
      });
      await page.getByRole("link", { name: link }).first().click();
      await expect(page).toHaveURL(new RegExp(`/${route}$`));
      await expect(page.locator("main [aria-busy=true]")).toBeVisible();
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `${dir}/${route.replace("/", "-")}-skeleton-${locale}-${scheme}-${width}.png` });
      release();
      await expect(page.locator("main h1").first()).toBeVisible();
      await appReady(page);
      expect(errors, `${route} skeleton ${locale} ${scheme} ${width}`).toEqual([]);
      await context.close();
    }
  }
});
