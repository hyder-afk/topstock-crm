import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { appReady, createUser, fullSession, isCancelledPrefetch, setRole, settled, sql, trackRequests } from "./helpers";

// Day 7b (Haider 15 Oct 2026: "do not keep any native pickers or popups on the app"): every picker the app now draws
// itself, used with the keyboard alone (Chromium), then photographed closed and open in English and French, light and
// dark, at 390 and 1440 (test-results/screens/day7b, copied into docs/evidence/day7b/screens); plus the two skeletons
// this step fixed (Recent activity draws the 8 rows the card holds; More draws Administration for admins only). Made-up
// people in an organisation of their own for this run.
test.describe.configure({ mode: "serial", timeout: 900_000 });

const dir = "test-results/screens/day7b";
const password = "Day7b-Pickers-Pass-42!";
const run = Date.now();
const email = (who: string) => `day7b-${who}-${run}@example.test`;
const uuid = /^[0-9a-f-]{36}$/;
let adminState: Awaited<ReturnType<BrowserContext["storageState"]>>;
let repState: Awaited<ReturnType<BrowserContext["storageState"]>>;
let adminSecret = "";
let lead = "";

type Messages = Record<string, unknown>;
const messages: Record<"en" | "fr", Messages> = {
  en: JSON.parse(readFileSync(path.join(__dirname, "../../messages/en.json"), "utf8")),
  fr: JSON.parse(readFileSync(path.join(__dirname, "../../messages/fr.json"), "utf8")),
};
/** A message's text, so the same steps run in English and French. */
const m = (locale: "en" | "fr", key: string, value?: string) => {
  const text = key.split(".").reduce<unknown>((node, k) => (node as Messages)[k], messages[locale]) as string;
  return value === undefined ? text : text.replace(/\{\w+\}/, value);
};

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  mkdirSync(dir, { recursive: true });
  adminSecret = await createUser(email("ines"), password, true);
  const repSecret = await createUser(email("sofia"), password, true);
  const org = sql(`insert into public.orgs (name) values ('Day 7b ${run}') returning id`);
  for (const [who, first, last, role] of [
    ["ines", "Inès", "Garnier", "admin"],
    ["sofia", "Sofia", "Lambert", "rep"],
  ] as const) {
    sql(`update public.profiles set org_id = '${org}', first_name = '${first}', last_name = '${last}', timezone = 'Europe/Paris'
         where id = (select id from auth.users where email = '${email(who)}')`);
    setRole(email(who), role);
  }
  lead = sql(`insert into public.companies (org_id, name, owner_id, lead_status, phone, email, city, country)
              select org_id, 'Maison Verdane ${run}', id, 'warm', '06 12 34 56 78', 'achats@example.com', 'Lyon', 'FR'
              from public.profiles where id = (select id from auth.users where email = '${email("ines")}') returning id`);
  expect(lead).toMatch(uuid);
  adminState = await fullSession(browser, email("ines"), password, adminSecret);
  repState = await fullSession(browser, email("sofia"), password, repSecret);
});

async function openPage(
  browser: Browser,
  o: { path: string; locale?: "en" | "fr"; scheme?: "light" | "dark"; width?: number; state?: typeof adminState },
) {
  const width = o.width ?? 1440;
  const context = await browser.newContext({
    storageState: o.state ?? adminState,
    viewport: { width, height: width < 600 ? 844 : 900 },
    colorScheme: o.scheme ?? "light",
    timezoneId: "Europe/Paris",
  });
  const baseURL = test.info().project.use.baseURL ?? "http://localhost:3100";
  await context.addCookies([{ name: "locale", value: o.locale ?? "en", url: baseURL }]);
  const page = await context.newPage();
  trackRequests(page);
  const errors: string[] = [];
  page.on("console", (msg) => msg.type() === "error" && !isCancelledPrefetch(msg.text()) && errors.push(`${msg.text()} (${msg.location().url})`));
  page.on("pageerror", (e) => !isCancelledPrefetch(e.message) && errors.push(e.message));
  await page.goto(o.path);
  await expect(page.locator("main h1").first()).toBeVisible();
  await appReady(page);
  return { context, page, errors };
}

const hidden = (page: Page, name: string) => page.locator(`input[type="hidden"][name="${name}"]`);

// ---------------------------------------------------------------------------------------------------------------------
// Keyboard only: each picker is reached with focus and worked with keys alone; nothing is clicked inside a picker.

test("keyboard only: Select (Add lead > Lead status)", async ({ browser }) => {
  const { context, page, errors } = await openPage(browser, { path: "/leads" });
  await page.getByRole("button", { name: m("en", "Leads.add") }).first().click();
  const dialog = page.getByRole("dialog", { name: m("en", "Leads.form.addTitle") });
  const status = dialog.getByLabel(m("en", "Leads.form.status"));
  await status.focus();
  const before = (await status.getAttribute("data-value")) ?? "";
  // Enter opens the list on the chosen option; arrows move; Enter picks and focus comes back to the trigger.
  await page.keyboard.press("Enter");
  const list = page.getByRole("listbox");
  await expect(list).toBeVisible();
  await expect(list.getByRole("option", { selected: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  // Radix moves the focus on the next tick; a person's next key always comes later than that.
  await expect(list.locator(`[role="option"]:not([data-option="${before}"])`).first()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(list).toBeHidden();
  await expect(status).toBeFocused();
  await expect(status).not.toHaveAttribute("data-value", before);
  const after = (await status.getAttribute("data-value")) ?? "";
  // Escape closes without a change and keeps the dialog open; typeahead on the closed trigger picks by first letter.
  await page.keyboard.press("Space");
  await expect(list).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(status).toHaveAttribute("data-value", after);
  await page.keyboard.press("n");
  await expect(status).toHaveAttribute("data-value", "negotiation");
  expect(errors).toEqual([]);
  await context.close();
});

test("keyboard only: Combobox (More > Time zone)", async ({ browser }) => {
  const { context, page, errors } = await openPage(browser, { path: "/more" });
  const zone = page.getByRole("combobox", { name: m("en", "Profile.timezone") });
  await zone.focus();
  await page.keyboard.press("Enter");
  const search = page.getByRole("dialog").getByRole("combobox");
  await expect(search).toBeFocused();
  await page.keyboard.type("tokyo");
  await expect(page.getByRole("option", { name: "Asia/Tokyo" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(search).toBeHidden();
  await expect(zone).toBeFocused();
  await expect(zone).toHaveAttribute("data-value", "Asia/Tokyo");
  await expect(hidden(page, "timezone")).toHaveValue("Asia/Tokyo");
  // Escape closes the list and gives focus back, value unchanged; accents and case are ignored when searching.
  await page.keyboard.press("ArrowDown");
  await expect(search).toBeFocused();
  await page.keyboard.type("SAO");
  await expect(page.getByRole("option", { name: "America/Sao Paulo" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(search).toBeHidden();
  await expect(zone).toBeFocused();
  await expect(zone).toHaveAttribute("data-value", "Asia/Tokyo");
  expect(errors).toEqual([]);
  await context.close();
});

test("keyboard only: DatePicker typed and its calendar, TimePicker (Tasks > quick add)", async ({ browser }) => {
  const { context, page, errors } = await openPage(browser, { path: "/tasks" });
  // The "Pick a date" chip, reached with the keyboard.
  await page.getByRole("button", { name: m("en", "Tasks.chips.pick") }).focus();
  await page.keyboard.press("Enter");
  const date = page.getByLabel(m("en", "Tasks.quickAdd.date"), { exact: true });
  await date.focus();
  // Typed in the locale's digit order (English: month/day/year), checked on Enter. The chip filled in a day already.
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("10/20/2026");
  await page.keyboard.press("Enter");
  await expect(hidden(page, "task_date")).toHaveValue("2026-10-20");
  // Alt+Down opens the month grid on that day; arrows move a day or a week, PageDown a month; Enter picks.
  await page.keyboard.press("Alt+ArrowDown");
  const grid = page.getByRole("grid");
  await expect(grid).toBeVisible();
  await expect(grid.locator('button[data-iso="2026-10-20"]')).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await expect(grid.locator('button[data-iso="2026-10-28"]')).toBeFocused();
  await page.keyboard.press("PageDown");
  await expect(grid.locator('button[data-iso="2026-11-28"]')).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(grid).toBeHidden();
  await expect(hidden(page, "task_date")).toHaveValue("2026-11-28");
  // Focus is back in the text box it was opened from. Escape closes the grid without a change.
  await expect(date).toBeFocused();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(grid).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("Escape");
  await expect(grid).toBeHidden();
  await expect(hidden(page, "task_date")).toHaveValue("2026-11-28");
  await expect(date).toBeFocused();
  // An impossible day is refused in place: empty value, aria-invalid, the text stays for fixing.
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("02/31/2026");
  await page.keyboard.press("Enter");
  await expect(date).toHaveAttribute("aria-invalid", "true");
  await expect(hidden(page, "task_date")).toHaveValue("");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("11/28/2026");
  await page.keyboard.press("Enter");

  // TimePicker: typed shorthand, then the 15-minute list with Down, arrows and Enter.
  const time = page.getByLabel(m("en", "Tasks.quickAdd.time"), { exact: true });
  await time.focus();
  await page.keyboard.type("915");
  await page.keyboard.press("Enter");
  await expect(hidden(page, "task_time")).toHaveValue("09:15");
  await page.keyboard.press("ArrowDown");
  const times = page.getByRole("listbox");
  await expect(times).toBeVisible();
  // The list opens on the current time (09:15); one step down is 09:30.
  await expect(times.getByRole("option", { selected: true })).toHaveText(/09:15/);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(times).toBeHidden();
  await expect(hidden(page, "task_time")).toHaveValue("09:30");
  await expect(time).toBeFocused();
  // Escape closes only the list.
  await page.keyboard.press("ArrowDown");
  await expect(times).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(times).toBeHidden();
  await expect(time).toBeFocused();
  await expect(hidden(page, "task_time")).toHaveValue("09:30");
  expect(errors).toEqual([]);
  await context.close();
});

test("keyboard only: DateTimePicker (lead Details > Next call)", async ({ browser }) => {
  const { context, page, errors } = await openPage(browser, { path: `/leads/${lead}?tab=details` });
  // The label names the date combobox; the time box is named from the same label plus "Time" (aria-labelledby).
  const day = page.getByRole("combobox", { name: m("en", "LeadPage.details.nextCall"), exact: true });
  await expect(page.getByRole("combobox", { name: `${m("en", "LeadPage.details.nextCall")} ${m("en", "Pickers.time")}`, exact: true })).toBeVisible();
  await day.focus();
  await page.keyboard.press("Enter");
  const grid = page.getByRole("grid");
  await expect(grid).toBeVisible();
  const focused = (await grid.locator("button[data-iso]:focus").getAttribute("data-iso")) ?? "";
  expect(focused).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(grid).toBeHidden();
  const picked = (await hidden(page, "next_action_at").inputValue()).slice(0, 10);
  expect(picked > focused).toBe(true);
  // The day picked first takes the default 09:00; Tab moves to the time, typed as "1030".
  await expect(hidden(page, "next_action_at")).toHaveValue(`${picked}T09:00`);
  await page.keyboard.press("Tab");
  await page.keyboard.type("1030");
  await page.keyboard.press("Enter");
  await expect(hidden(page, "next_action_at")).toHaveValue(`${picked}T10:30`);
  expect(errors).toEqual([]);
  await context.close();
});

test("keyboard only: Tooltip (dock), SearchInput (leads), Disclosure (lead Stock > Link options)", async ({ browser }) => {
  const { context, page, errors } = await openPage(browser, { path: "/leads" });
  // Tooltip: at once on keyboard focus, gone on Escape; it describes the link (the shortcut) and never names it.
  const leadsLink = page.getByRole("navigation", { name: m("en", "Nav.label") }).getByRole("link", { name: "Leads" });
  await leadsLink.focus();
  const tip = page.getByRole("tooltip");
  await expect(tip).toHaveText(m("en", "Shortcuts.tooltip", "L"));
  await expect(leadsLink).toHaveAccessibleName("Leads");
  await expect(leadsLink).toHaveAccessibleDescription(m("en", "Shortcuts.tooltip", "L"));
  await page.keyboard.press("Escape");
  await expect(tip).toBeHidden();

  // SearchInput: Escape empties a filled box; the clear button is reached with Tab and works with Enter.
  const search = page.getByRole("searchbox", { name: m("en", "Leads.searchLabel") });
  await search.focus();
  await page.keyboard.type("verdane");
  await expect(page).toHaveURL(/[?&]q=verdane/);
  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("");
  await page.keyboard.type("lyon");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: m("en", "Pickers.clearSearch") })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();

  // Disclosure: Enter and Space toggle; screen readers hear expanded/collapsed from the browser's own <details>.
  await page.goto(`/leads/${lead}?tab=stock`);
  await appReady(page);
  const options = page.locator("summary").filter({ hasText: m("en", "ShareLinks.options") });
  await options.focus();
  const details = options.locator("xpath=..");
  await expect(details).not.toHaveAttribute("open", "");
  await page.keyboard.press("Enter");
  await expect(details).toHaveAttribute("open", "");
  await page.keyboard.press("Space");
  await expect(details).not.toHaveAttribute("open", "");
  // No browser triangle: the marker is hidden, our chevron is drawn.
  expect(await options.evaluate((el) => getComputedStyle(el).listStyleType)).toBe("none");
  await expect(options.locator("svg")).toHaveCount(1);
  await settled(page);
  expect(errors).toEqual([]);
  await context.close();
});

// ---------------------------------------------------------------------------------------------------------------------
// Screenshots: each picker closed and open, EN/FR, light/dark, 390 and 1440. The shot is the picker and its panel with
// 24 px around them (clipped to the screen). Every shot checks for console errors and sideways scroll first.
// CI takes 390 and 1440 only. The other widths CLAUDE.md asks for come from a local evidence run, committed as images,
// so CI spends no extra minutes: DAY7B_WIDTHS=768,1024,1280,1728 (and DAY7B_SCREENS=1 for the whole changed screens below).
const shotWidths = (process.env.DAY7B_WIDTHS ?? "390,1440").split(",").map((w) => Number(w.trim()));

type Picker = {
  name: string;
  path: () => string;
  /** The picker's trigger, with anything needed to reach it done (a dialog opened, a chip pressed). */
  trigger: (page: Page, locale: "en" | "fr") => Promise<Locator>;
  /** Opens it and returns its floating panel (or what it reveals). */
  open: (page: Page, trigger: Locator, locale: "en" | "fr") => Promise<Locator>;
};

const pickers: Picker[] = [
  {
    name: "select",
    path: () => "/leads",
    trigger: async (page, l) => {
      await page.getByRole("button", { name: m(l, "Leads.add") }).first().click();
      return page.getByRole("dialog", { name: m(l, "Leads.form.addTitle") }).getByLabel(m(l, "Leads.form.status"));
    },
    open: async (page, trigger) => {
      await trigger.click();
      return page.getByRole("listbox");
    },
  },
  {
    name: "combobox",
    path: () => "/more",
    trigger: async (page, l) => page.getByRole("combobox", { name: m(l, "Profile.timezone") }),
    open: async (page, trigger) => {
      await trigger.click();
      await page.getByRole("dialog").getByRole("combobox").fill("paris");
      return page.getByRole("dialog").filter({ has: page.getByRole("listbox") });
    },
  },
  {
    name: "date-picker",
    path: () => "/tasks",
    trigger: async (page, l) => {
      await page.getByRole("button", { name: m(l, "Tasks.chips.pick") }).click();
      const field = page.getByLabel(m(l, "Tasks.quickAdd.date"), { exact: true });
      await field.fill(l === "fr" ? "20/10/2026" : "10/20/2026");
      await field.press("Enter");
      return field.locator("xpath=..");
    },
    open: async (page, trigger) => {
      await trigger.locator("input").first().focus();
      await page.keyboard.press("Alt+ArrowDown");
      return page.getByRole("dialog").filter({ has: page.getByRole("grid") });
    },
  },
  {
    name: "time-picker",
    path: () => "/tasks",
    trigger: async (page, l) => {
      // The time waits for a day: Today is the usual default; pressed again it would clear it.
      const field = page.getByLabel(m(l, "Tasks.quickAdd.time"), { exact: true });
      const today = page.getByRole("button", { name: m(l, "Tasks.chips.today"), exact: true });
      if ((await today.getAttribute("aria-pressed")) !== "true") await today.click();
      await expect(field).toBeEnabled();
      return field;
    },
    open: async (page, trigger) => {
      await trigger.focus();
      await page.keyboard.press("ArrowDown");
      return page.getByRole("listbox");
    },
  },
  {
    name: "date-time-picker",
    path: () => `/leads/${lead}?tab=details`,
    trigger: async (page) => page.getByRole("group").filter({ has: page.locator('input[name="next_action_at"]') }).first(),
    open: async (page, trigger) => {
      await trigger.getByRole("combobox").first().click();
      return page.getByRole("dialog").filter({ has: page.getByRole("grid") });
    },
  },
  {
    name: "tooltip",
    path: () => "/leads",
    trigger: async (page, l) => page.getByRole("navigation", { name: m(l, "Nav.label") }).getByRole("link").nth(1),
    open: async (page, trigger) => {
      await trigger.focus();
      return page.getByRole("tooltip");
    },
  },
  {
    name: "search-input",
    path: () => "/leads",
    trigger: async (page, l) => page.getByRole("searchbox", { name: m(l, "Leads.searchLabel") }),
    open: async (page, trigger, l) => {
      await trigger.fill("Verdane");
      return page.getByRole("button", { name: m(l, "Pickers.clearSearch") });
    },
  },
  {
    name: "disclosure",
    path: () => `/leads/${lead}?tab=stock`,
    trigger: async (page, l) => page.locator("summary").filter({ hasText: m(l, "ShareLinks.options") }),
    open: async (_page, trigger) => {
      await trigger.click();
      return trigger.locator("xpath=..");
    },
  },
];

type Box = { x: number; y: number; width: number; height: number };
async function boxOf(part: Locator) {
  return part.first().boundingBox({ timeout: 10_000 });
}
// The trigger's box is measured while closed: an open Select or dialog hides the rest of the page from the
// accessibility tree (Radix), so a role-based locator for the trigger would no longer resolve.
async function clipShot(page: Page, file: string, parts: (Locator | Box)[]) {
  const boxes: Box[] = [];
  for (const p of parts) {
    const box = "x" in p ? p : await boxOf(p);
    if (box) boxes.push(box);
  }
  expect(boxes.length).toBeGreaterThan(0);
  const view = page.viewportSize()!;
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - 24);
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - 24);
  const right = Math.min(view.width, Math.max(...boxes.map((b) => b.x + b.width)) + 24);
  const bottom = Math.min(view.height, Math.max(...boxes.map((b) => b.y + b.height)) + 24);
  await page.screenshot({ path: file, clip: { x, y, width: right - x, height: bottom - y } });
}

for (const picker of pickers) {
  test(`screens: ${picker.name} closed and open, EN/FR, light/dark`, async ({ browser }) => {
    for (const locale of ["en", "fr"] as const) {
      for (const scheme of ["light", "dark"] as const) {
        for (const width of shotWidths) {
          const { context, page, errors } = await openPage(browser, { path: picker.path(), locale, scheme, width });
          const trigger = await picker.trigger(page, locale);
          // In the middle of the screen, clear of the floating dock (it would sit over a trigger near the bottom).
          await trigger.evaluate((el) => el.scrollIntoView({ block: "center" }));
          await expect(trigger).toBeVisible();
          expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
          const base = `${dir}/${picker.name}-${locale}-${scheme}-${width}`;
          await page.mouse.move(0, 0);
          const closedBox = await boxOf(trigger);
          expect(closedBox).not.toBeNull();
          await clipShot(page, `${base}-closed.png`, [closedBox!]);
          const panel = await picker.open(page, trigger, locale);
          await expect(panel.first()).toBeVisible();
          // The open animation (settle-in, transform + opacity) finishes before the shot.
          await page.waitForTimeout(300);
          expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
          await clipShot(page, `${base}-open.png`, [closedBox!, panel]);
          await settled(page);
          expect(errors, `${picker.name} ${locale} ${scheme} ${width}`).toEqual([]);
          await context.close();
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The screens whose pickers changed, whole (the visible screen, with the picker's field in the middle), at every width
// CLAUDE.md lists, EN/FR, light/dark. Local evidence run only (DAY7B_SCREENS=1): CI runs the picker shots above.

type Screen = { name: string; path: () => string; prepare?: (page: Page, locale: "en" | "fr") => Promise<Locator | void> };
const changedScreens: Screen[] = [
  { name: "leads", path: () => "/leads", prepare: async (page, l) => page.getByRole("searchbox", { name: m(l, "Leads.searchLabel") }) },
  {
    name: "lead-add",
    path: () => "/leads",
    prepare: async (page, l) => {
      await page.getByRole("button", { name: m(l, "Leads.add") }).first().click();
      const dialog = page.getByRole("dialog", { name: m(l, "Leads.form.addTitle") });
      await expect(dialog).toBeVisible();
      await page.waitForTimeout(400);
    },
  },
  {
    name: "lead-details",
    path: () => `/leads/${lead}?tab=details`,
    prepare: async (page) => page.getByRole("group").filter({ has: page.locator('input[name="next_action_at"]') }).first(),
  },
  { name: "lead-stock", path: () => `/leads/${lead}?tab=stock`, prepare: async (page, l) => page.locator("summary").filter({ hasText: m(l, "ShareLinks.options") }) },
  {
    name: "tasks",
    path: () => "/tasks",
    prepare: async (page, l) => {
      await page.getByRole("button", { name: m(l, "Tasks.chips.pick") }).click();
      return page.getByLabel(m(l, "Tasks.quickAdd.date"), { exact: true });
    },
  },
  { name: "inventory", path: () => "/inventory" },
  { name: "more", path: () => "/more", prepare: async (page, l) => page.getByRole("combobox", { name: m(l, "Profile.timezone") }) },
];

test.describe("changed screens", () => {
  test.skip(!process.env.DAY7B_SCREENS, "local evidence run: set DAY7B_SCREENS=1");
  const widths = (process.env.DAY7B_WIDTHS ?? "390,768,1024,1280,1440,1728").split(",").map((w) => Number(w.trim()));
  for (const screen of changedScreens) {
    test(`changed screen: ${screen.name}, EN/FR, light/dark`, async ({ browser }) => {
      for (const locale of ["en", "fr"] as const) {
        for (const scheme of ["light", "dark"] as const) {
          for (const width of widths) {
            const { context, page, errors } = await openPage(browser, { path: screen.path(), locale, scheme, width });
            const focus = await screen.prepare?.(page, locale);
            if (focus) {
              await expect(focus.first()).toBeVisible();
              await focus.first().evaluate((el) => el.scrollIntoView({ block: "center" }));
            }
            await page.mouse.move(0, 0);
            await settled(page);
            expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${screen.name} ${width}`).toBeLessThanOrEqual(0);
            await page.screenshot({ path: `${dir}/screen-${screen.name}-${locale}-${scheme}-${width}.png` });
            expect(errors, `${screen.name} ${locale} ${scheme} ${width}`).toEqual([]);
            await context.close();
          }
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Skeletons this step fixed (plan section 2, design polish 6 and 7).

// Holds back the server's answer to a client navigation, so the route's loading.tsx shows. Prefetches go through: they
// carry the loading layout itself.
async function holdRoute(page: Page, pathname: string) {
  await page.route(
    (url) => url.pathname === pathname && url.searchParams.has("_rsc"),
    async (route) => {
      const headers = route.request().headers();
      if (headers["next-router-prefetch"] || headers["next-router-segment-prefetch"]) return route.continue();
      await new Promise((r) => setTimeout(r, 4000));
      await route.continue().catch(() => {});
    },
  );
}

test("skeleton: Recent activity draws the 8 rows the card holds", async ({ browser }) => {
  const { context, page, errors } = await openPage(browser, { path: "/leads" });
  await holdRoute(page, "/");
  await page.getByRole("navigation", { name: m("en", "Nav.label") }).getByRole("link").first().click();
  const recent = page.locator('[data-skeleton="recent"]');
  await expect(recent).toBeVisible();
  await expect(recent.locator(".h-14")).toHaveCount(8);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await settled(page);
  expect(errors).toEqual([]);
  await context.close();
});

test("skeleton: More draws Administration for admins only, as the page does", async ({ browser }) => {
  for (const [who, state, shows] of [
    ["admin", adminState, true],
    ["rep", repState, false],
  ] as const) {
    const { context, page, errors } = await openPage(browser, { path: "/leads", state });
    await holdRoute(page, "/more");
    // The dock link's prefetch (with More's loading layout) lands first.
    await page.waitForTimeout(1000);
    await page.locator('a[href="/more"]').first().click();
    const skeleton = page.locator('main [aria-busy="true"]');
    await expect(skeleton, who).toBeVisible();
    if (shows) await expect(page.locator('[data-skeleton="more-admin"]'), who).toBeVisible();
    else await expect(page.locator('[data-skeleton="more-admin"]'), who).toBeHidden();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    // The page itself agrees: Administration only for the admin.
    await expect(page.locator("main h1")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#more-admin"), who).toHaveCount(shows ? 1 : 0);
    await settled(page);
    expect(errors, who).toEqual([]);
    await context.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// List states (plan section 4, 7b): the lists whose loading, empty or error state no earlier test reached. Each one is
// read in the browser, so its request is held back (the skeleton, never a spinner) or refused (the error with its
// retry), then let through (the empty state, or the list). The other lists' tests are named in docs/evidence/day7b.

async function hold(page: Page, match: (url: URL) => boolean, ms = 1500) {
  await page.route(match, async (route) => {
    await new Promise((r) => setTimeout(r, ms));
    await route.continue().catch(() => {});
  });
}
async function refuse(page: Page, match: (url: URL) => boolean, status = 502) {
  await page.route(match, (route) => route.fulfill({ status, contentType: "application/json", body: '{"error":"unavailable"}' }));
}
const pulse = (scope: Locator) => scope.locator(".motion-safe\\:animate-pulse").first();
const serverErrors = (errors: string[]) => errors.filter((e) => !/50[02]|Bad Gateway|Internal Server Error/.test(e));

test("list states: Leads (skeleton rows, error with Try again, no match, the list)", async ({ browser }) => {
  const { context, page, errors } = await openPage(browser, { path: "/leads" });
  const leadsApi = (url: URL) => url.pathname === "/api/leads";
  await hold(page, leadsApi);
  await page.getByRole("searchbox", { name: m("en", "Leads.searchLabel") }).fill("verd");
  await expect(pulse(page.locator("main"))).toBeVisible();
  await page.unrouteAll({ behavior: "wait" });
  await expect(page.getByRole("table", { name: "Leads" }).getByRole("link", { name: new RegExp(`Maison Verdane ${run}`) })).toBeVisible();
  await refuse(page, leadsApi);
  await page.getByRole("searchbox", { name: m("en", "Leads.searchLabel") }).fill("zzzz-nothing");
  const alert = page.getByRole("alert").filter({ hasText: m("en", "Leads.errorTitle") });
  await expect(alert).toBeVisible({ timeout: 15_000 });
  await page.unrouteAll({ behavior: "wait" });
  await alert.getByRole("button", { name: m("en", "Leads.retry") }).click();
  await expect(page.getByText(m("en", "Leads.noMatchTitle"))).toBeVisible();
  await page.getByRole("button", { name: m("en", "Leads.clearFilters") }).click();
  await expect(page.getByRole("table", { name: "Leads" }).getByRole("link", { name: new RegExp(`Maison Verdane ${run}`) })).toBeVisible();
  await settled(page);
  expect(serverErrors(errors)).toEqual([]);
  await context.close();

  // No leads at all: the rep, moved for this check into an organisation of their own, gets the rep's empty state.
  const repOrg = sql(`select org_id from public.profiles where id = (select id from auth.users where email = '${email("sofia")}')`);
  const emptyOrg = sql(`insert into public.orgs (name) values ('Day 7b empty ${run}') returning id`);
  sql(`update public.profiles set org_id = '${emptyOrg}' where id = (select id from auth.users where email = '${email("sofia")}')`);
  try {
    const rep = await openPage(browser, { path: "/leads", state: repState });
    await expect(rep.page.getByText(m("en", "Leads.emptyTitle"))).toBeVisible();
    await expect(rep.page.getByText(m("en", "Leads.emptyBodyRep"))).toBeVisible();
    // One red primary action on the screen (Apple audit #23): the header's Add; the empty state's Add is quiet.
    await expect(rep.page.getByRole("button", { name: m("en", "Leads.add") })).toHaveCount(2);
    await expect(rep.page.locator("main").locator("button.bg-brand, a.bg-brand")).toHaveCount(1);
    await settled(rep.page);
    expect(rep.errors).toEqual([]);
    await rep.context.close();
  } finally {
    sql(`update public.profiles set org_id = '${repOrg}' where id = (select id from auth.users where email = '${email("sofia")}')`);
  }
});

test("list states: lead timeline, deals and share links (skeleton, error with retry, empty)", async ({ browser }) => {
  const { context, page, errors } = await openPage(browser, { path: `/leads/${lead}?tab=timeline` });
  // Timeline: empty from the server's first page; a filtered read is the browser's.
  await expect(page.getByText(m("en", "Timeline.empty")).filter({ visible: true })).toBeVisible();
  const activities = (url: URL) => url.pathname === `/api/leads/${lead}/activities`;
  await refuse(page, activities);
  await page.getByRole("group", { name: m("en", "Timeline.filterLabel") }).getByRole("button", { name: m("en", "Timeline.filters.call") }).click();
  const timelineError = page.getByText(m("en", "Timeline.error"));
  await expect(timelineError).toBeVisible({ timeout: 15_000 });
  await page.unrouteAll({ behavior: "wait" });
  await hold(page, activities);
  await page.getByRole("button", { name: m("en", "Timeline.retry") }).click();
  await expect(page.getByText(m("en", "Timeline.emptyFiltered")).filter({ visible: true })).toBeVisible();
  await page.unrouteAll({ behavior: "wait" });

  // Deals tab: its own read (skeleton, then refused, then empty).
  const deals = (url: URL) => url.pathname === `/api/leads/${lead}/deals`;
  await refuse(page, deals);
  await page.goto(`/leads/${lead}?tab=deals`);
  await appReady(page);
  const dealsError = page.getByRole("alert").filter({ hasText: m("en", "LeadPage.deals.loadFailed") });
  await expect(dealsError).toBeVisible({ timeout: 15_000 });
  await page.unrouteAll({ behavior: "wait" });
  await hold(page, deals);
  await dealsError.getByRole("button", { name: m("en", "LeadPage.deals.retry") }).click();
  await expect(page.locator('ul[aria-busy="true"]')).toBeVisible();
  await expect(page.getByText(m("en", "LeadPage.dealsEmpty")).filter({ visible: true })).toBeVisible();
  await page.unrouteAll({ behavior: "wait" });

  // Share links (Stock tab): skeleton, refused (now an alert), then "No active link".
  const links = (url: URL) => url.pathname === "/api/inventory/share-links";
  await refuse(page, links);
  await page.goto(`/leads/${lead}?tab=stock`);
  await appReady(page);
  const linksError = page.getByRole("alert").filter({ hasText: m("en", "ShareLinks.loadError") });
  await expect(linksError).toBeVisible({ timeout: 15_000 });
  await page.unrouteAll({ behavior: "wait" });
  await hold(page, links);
  await linksError.getByRole("button", { name: m("en", "ShareLinks.retry") }).click();
  await expect(page.getByText(m("en", "ShareLinks.none"))).toBeVisible();
  await page.unrouteAll({ behavior: "wait" });
  await settled(page);
  expect(serverErrors(errors)).toEqual([]);
  await context.close();
});

test("list states: Tasks (skeleton rows, error with Try again, empty tab)", async ({ browser }) => {
  const { context, page, errors } = await openPage(browser, { path: "/tasks" });
  const tasksApi = (url: URL) => url.pathname === "/api/tasks";
  await refuse(page, tasksApi);
  await page.getByRole("tab", { name: new RegExp(`^${m("en", "Tasks.tabs.upcoming")}`) }).click();
  const tasksError = page.getByText(m("en", "Tasks.error"));
  await expect(tasksError).toBeVisible({ timeout: 15_000 });
  await page.unrouteAll({ behavior: "wait" });
  await hold(page, tasksApi);
  await page.getByRole("button", { name: m("en", "Tasks.retry") }).click();
  await expect(pulse(page.locator("main"))).toBeVisible();
  await expect(page.getByText(m("en", "Tasks.empty.upcoming"))).toBeVisible();
  await page.unrouteAll({ behavior: "wait" });
  await settled(page);
  expect(serverErrors(errors)).toEqual([]);
  await context.close();
});

test("list states: Inventory tabs (arriving, reserved, movements, sales, requests), the queue's counts, stock imports", async ({ browser }) => {
  const { context, page, errors } = await openPage(browser, { path: "/inventory" });
  const tabs = [
    { tab: "arriving", api: "/api/inventory/stock", error: "Inventory.arriving.error", empty: "Inventory.arriving.emptyTitle" },
    { tab: "reserved", api: "/api/inventory/reservations", error: "Inventory.reserved.error", empty: "Inventory.reserved.emptyTitle" },
    { tab: "movements", api: "/api/inventory/movements", error: "Inventory.movements.error", empty: "Inventory.movements.emptyTitle" },
    { tab: "sales", api: "/api/inventory/sales", error: "Sales.list.error", empty: "Sales.list.emptyTitle" },
    { tab: "requests", api: "/api/inventory/requests", error: "Sales.requests.error", empty: "Sales.requests.emptyTitle" },
  ];
  for (const { tab, api, error, empty } of tabs) {
    const match = (url: URL) => url.pathname === api;
    await refuse(page, match);
    await page.goto(`/inventory?tab=${tab}`);
    await appReady(page);
    const alert = page.getByRole("alert").filter({ hasText: m("en", error) });
    await expect(alert, tab).toBeVisible({ timeout: 15_000 });
    await page.unrouteAll({ behavior: "wait" });
    await hold(page, match);
    await alert.getByRole("button", { name: m("en", "Inventory.retry") }).click();
    await expect(pulse(page.locator("main")), tab).toBeVisible();
    await expect(page.getByRole("heading", { name: m("en", empty) }), tab).toBeVisible();
    await page.unrouteAll({ behavior: "wait" });
    // Nothing left in flight when the next tab is opened (no request crosses a navigation).
    await settled(page);
  }

  // The work queue's counts (the server's first answer is on the page; a changed setting reads them again in the
  // browser): refused, then Retry.
  const summary = (url: URL) => url.pathname === "/api/queue/summary";
  await page.goto("/leads/queue");
  await appReady(page);
  await refuse(page, summary);
  await page.getByRole("switch", { name: m("en", "Queue.skipLunch") }).click();
  const countsError = page.getByRole("alert").filter({ hasText: m("en", "Queue.summaryError") });
  await expect(countsError).toBeVisible({ timeout: 15_000 });
  await page.unrouteAll({ behavior: "wait" });
  // The alert goes the moment Retry starts reading (the counts have no data yet, so the query is pending again), not
  // when the answer lands: wait for the answer and the counts it draws, and leave the page only once nothing is in
  // flight. Navigating while that read was open left it counted as pending for good on CI (PR #19).
  const answered = page.waitForResponse((r) => summary(new URL(r.url())) && r.request().method() === "GET");
  await countsError.getByRole("button", { name: m("en", "Queue.retry") }).click();
  expect((await answered).status()).toBe(200);
  await expect(countsError).toBeHidden();
  await expect(page.locator("#queue-counts + ul")).toBeVisible();
  await settled(page);

  // Past stock imports: none yet in this organisation.
  await page.goto("/inventory/import");
  await appReady(page);
  await expect(page.getByText(m("en", "StockImport.history.empty"))).toBeVisible();
  await settled(page);
  expect(serverErrors(errors)).toEqual([]);
  await context.close();
});

// Day 7b advisor round: the three error states a browser can reach after the page has loaded. Each read is refused
// once it is asked for again (a refetch or a refresh after another action), then let through with the retry.

test("list states: lead tasks (Next step) error after a failed refetch, then Try again", async ({ browser }) => {
  // A lead of its own with no next call and no task: Next step offers the date chips.
  const quiet = sql(`insert into public.companies (org_id, name, owner_id, lead_status, city, country)
                     select org_id, 'Atelier Prochain ${run}', id, 'warm', 'Lyon', 'FR'
                     from public.profiles where id = (select id from auth.users where email = '${email("ines")}') returning id`);
  expect(quiet).toMatch(uuid);
  const { context, page, errors } = await openPage(browser, { path: `/leads/${quiet}` });
  const card = page.getByRole("region", { name: m("en", "LeadPage.nextStep") });
  await expect(card.getByText(m("en", "LeadPage.noNextStep"))).toBeVisible();
  // The tasks route answers 500 from now on. A chip adds a call task, and the card reads the lead's tasks again
  // (refreshLead invalidates ["lead-tasks", id]): that read is refused (and its one retry), so the card says so.
  const tasksApi = (url: URL) => url.pathname === `/api/leads/${quiet}/tasks`;
  await refuse(page, tasksApi, 500);
  await card.getByRole("button", { name: m("en", "Composer.chips.tomorrow"), exact: true }).click();
  const alert = card.getByRole("alert").filter({ hasText: m("en", "LeadPage.tasks.error") });
  await expect(alert).toBeVisible({ timeout: 15_000 });
  // Let through: Try again shows the task the chip added.
  await page.unrouteAll({ behavior: "wait" });
  await alert.getByRole("button", { name: m("en", "LeadPage.tasks.retry") }).click();
  await expect(alert).toBeHidden();
  const title = m("en", "Outcomes.taskTitle.followUp", `Atelier Prochain ${run}`);
  await expect(card.getByRole("checkbox", { name: m("en", "LeadPage.tasks.markDone", title) })).toBeVisible();
  await settled(page);
  expect(serverErrors(errors)).toEqual([]);
  await context.close();
});

// A server action is a POST to the page's own URL with a Next-Action header (as tasks.spec and files.spec cut them).
async function cutActions(page: Page, pathname: string) {
  await page.route(
    (url) => url.pathname === pathname,
    async (route) => {
      const request = route.request();
      if (request.method() === "POST" && request.headers()["next-action"]) return route.abort();
      return route.fallback();
    },
  );
}

test("list states: past lead imports and past stock imports, error after a failed refresh, then Try again", async ({ browser }) => {
  // A fresh code: Discard asks for one when the last is older than its window, and this run has taken minutes.
  const state = await fullSession(browser, email("ines"), password, adminSecret);
  for (const { kind, path: where, keys } of [
    { kind: "leads", path: "/leads/import", keys: "Import.history" },
    { kind: "stock", path: "/inventory/import", keys: "StockImport.history" },
  ] as const) {
    // An unfinished upload in Past imports (its Discard is the action that refreshes the list afterwards).
    const filename = `day7b-${kind}-${run}.csv`;
    const batch = sql(`insert into public.import_batches (org_id, kind, filename, uploaded_by, row_count, last_row_no, status)
                       select org_id, '${kind}', '${filename}', id, 1, 2, 'staged'
                       from public.profiles where id = (select id from auth.users where email = '${email("ines")}') returning id`);
    expect(batch, kind).toMatch(uuid);
    try {
      const { context, page, errors } = await openPage(browser, { path: where, state });
      const history = page.locator(`[aria-labelledby="${kind === "leads" ? "import-history-heading" : "stock-history-heading"}"]`);
      await expect(history.getByRole("heading", { name: m("en", `${keys}.title`) }), kind).toBeVisible();
      const row = history.locator("li").filter({ hasText: filename });
      await expect(row, kind).toBeVisible();
      // Every server action on this page fails from now on (the connection drops): Discard fails, and so does the
      // refresh of Past imports after it (listImports / listStockImports), which shows the error with its retry.
      await cutActions(page, where);
      await row.getByRole("button", { name: m("en", `${keys}.discard`) }).click();
      const confirm = page.getByRole("dialog", { name: m("en", "Import.discardConfirm.title") });
      await confirm.getByRole("button", { name: m("en", "Import.discardConfirm.confirm") }).click();
      const alert = history.getByRole("alert").filter({ hasText: m("en", `${keys}.error`) });
      await expect(alert, kind).toBeVisible({ timeout: 20_000 });
      // Back online: Try again reads the list, the error goes and the upload is still there (nothing was discarded).
      await page.unrouteAll({ behavior: "wait" });
      await alert.getByRole("button", { name: m("en", `${keys}.retry`) }).click();
      await expect(alert, kind).toBeHidden();
      await expect(row, kind).toBeVisible();
      await settled(page);
      // The cut actions log "Failed to fetch" in the console: expected here, nothing else is.
      expect(errors.filter((e) => !/Failed to fetch|ERR_FAILED|net::/.test(e)), kind).toEqual([]);
      await context.close();
    } finally {
      sql(`delete from public.import_batches where id = '${batch}'`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// One screenshot per list state this step changed (local evidence run only, DAY7B_SCREENS=1; nothing in CI): Recent
// activity's 8-row skeleton, More's skeleton for an admin and for a rep, and the share links' error (now an alert).
// The visible screen, EN, light and dark, at 390 and 1440: screens/state-<name>-en-<scheme>-<width>.png.

// `reach` answers what to scroll to the middle, or null for a skeleton (at the top already, and gone a few seconds later).
type StateShot = { name: string; state?: () => typeof adminState; start: () => string; reach: (page: Page) => Promise<Locator | null> };
const stateShots: StateShot[] = [
  {
    name: "recent-skeleton",
    start: () => "/leads",
    reach: async (page) => {
      await holdRoute(page, "/");
      await page.getByRole("navigation", { name: m("en", "Nav.label") }).getByRole("link").first().click();
      const recent = page.locator('[data-skeleton="recent"]');
      await expect(recent.locator(".h-14")).toHaveCount(8);
      // Below the fold at 1440: brought to the middle while it is there (it goes when the page arrives).
      await recent.evaluate((el) => el.scrollIntoView({ block: "center" }), undefined, { timeout: 2_000 });
      return null;
    },
  },
  ...(["admin", "rep"] as const).map((who) => ({
    name: `more-skeleton-${who}`,
    state: () => (who === "admin" ? adminState : repState),
    start: () => "/leads",
    reach: async (page: Page) => {
      await holdRoute(page, "/more");
      await page.waitForTimeout(1000);
      await page.locator('a[href="/more"]').first().click();
      const skeleton = page.locator('main [aria-busy="true"]');
      await expect(skeleton).toBeVisible();
      // The rep's copy is in the page but hidden by CSS (data-role), so visibility is checked, not the count.
      const admin = page.locator('[data-skeleton="more-admin"]');
      if (who === "admin") await expect(admin).toBeVisible();
      else await expect(admin).toBeHidden();
      return null;
    },
  })),
  {
    name: "share-links-error",
    start: () => `/leads/${lead}`,
    reach: async (page) => {
      await refuse(page, (url) => url.pathname === "/api/inventory/share-links");
      await page.goto(`/leads/${lead}?tab=stock`);
      await appReady(page);
      const alert = page.getByRole("alert").filter({ hasText: m("en", "ShareLinks.loadError") });
      await expect(alert).toBeVisible({ timeout: 15_000 });
      return alert;
    },
  },
];

test.describe("state screens", () => {
  test.skip(!process.env.DAY7B_SCREENS, "local evidence run: set DAY7B_SCREENS=1");
  for (const shot of stateShots) {
    test(`state screen: ${shot.name}, light/dark, 390 and 1440`, async ({ browser }) => {
      for (const scheme of ["light", "dark"] as const) {
        for (const width of [390, 1440]) {
          const { context, page, errors } = await openPage(browser, { path: shot.start(), scheme, width, state: shot.state?.() });
          const target = await shot.reach(page);
          if (target) await target.evaluate((el) => el.scrollIntoView({ block: "center" }), undefined, { timeout: 10_000 });
          await page.mouse.move(0, 0);
          expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${shot.name} ${width}`).toBeLessThanOrEqual(0);
          await page.screenshot({ path: `${dir}/state-${shot.name}-en-${scheme}-${width}.png` });
          await page.unrouteAll({ behavior: "ignoreErrors" });
          await settled(page);
          expect(serverErrors(errors), `${shot.name} ${scheme} ${width}`).toEqual([]);
          await context.close();
        }
      }
    });
  }
});
