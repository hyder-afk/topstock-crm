import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { appReady, createUser, fullSession, isCancelledPrefetch, settled, sql, trackRequests } from "./helpers";
import { makeOrg, moveTo, seedHome, userId } from "./home-fixture";

// Day 7c phone pass (plan section 4 row 7c, "every route"): every route of the app on a 390 x 844 phone, English and
// French: the signed-in sections and their sub-pages, the sign-in pages (signed out, half signed in for the code, and a
// person without an authenticator for its set-up) and the client stock page (a seeded link).
// - phone_fit (runs in CI): at 390 no sideways scroll, every tap target at least 44 px across its centre in both
//   directions (its hit area as the browser hit-tests it, so a pseudo-element that widens a link counts), nothing at the
//   end of the page left under the dock, the dock's five sections, no control label, heading, line-clamped label or
//   placeholder cut, no console error; in French also at 768 and 1280 (French runs about 20 % longer): no sideways
//   scroll and nothing cut.
// - phone_sheets (runs in CI): the phone sheets and dialogs fit the screen (inside the viewport, no sideways scroll,
//   their own targets 44 px).
// - phone_safe_areas (CI, Chromium): emulated notch insets.
// - phone_call_panel_tab (CI): with the call panel open on a phone, every page control reached with Tab ends above it.
// - phone_shots (DAY7C_PHONE=1 only, so CI time does not change): screenshots into DAY7C_PHONE_DIR (locally
//   docs/evidence/day7c/phone): every route at 390 and 768, the sheets, and the part-2 desktop changes at 1280 to 1728.
// The person is an admin in an org made for this run (Home's fixture plus a small catalogue), so the screens hold data.
test.describe.configure({ mode: "serial", timeout: 900_000 });
test.use({ actionTimeout: 15_000 });

const SHOTS = process.env.DAY7C_PHONE === "1";
const dir = process.env.DAY7C_PHONE_DIR || "test-results/phone";
const password = "Phone-Pass-Screens-42!";
const run = Date.now();
const adminEmail = `phone-admin-${run}@example.test`;
const repEmail = `phone-rep-${run}@example.test`;
type State = Awaited<ReturnType<BrowserContext["storageState"]>>;
let state: State;
let halfState: State; // password done, the 6-digit code still to come (/mfa)
let setupState: State; // a person without an authenticator yet (/mfa/setup)
let leadId = "";
let productId = "";

const routes: { name: string; path: () => string }[] = [
  { name: "home", path: () => "/" },
  { name: "leads", path: () => "/leads" },
  { name: "lead", path: () => `/leads/${leadId}` },
  { name: "pipeline", path: () => "/pipeline" },
  { name: "tasks", path: () => "/tasks" },
  { name: "queue", path: () => "/leads/queue" },
  { name: "inventory", path: () => "/inventory" },
  { name: "sales", path: () => "/inventory?tab=sales" },
  { name: "more", path: () => "/more" },
  { name: "team", path: () => "/more/team" },
  { name: "import", path: () => "/leads/import" },
  { name: "stock-import", path: () => "/inventory/import" },
  { name: "product", path: () => `/inventory/p/${productId}` },
  { name: "inventory-settings", path: () => "/inventory/settings" },
  { name: "client-view", path: () => "/inventory/client-view" },
  { name: "analytics", path: () => "/analytics" },
  { name: "file-unavailable", path: () => "/files/unavailable" },
];

// Pages outside the signed-in shell (no dock): who opens them, and the path. The client page gets a fresh link each time
// (a link answers 30 views a minute) and its own documentation address as the client (RFC 5737), apart from other tests.
type Who = "out" | "half" | "setup" | "in";
const publicPages: { name: string; who: Who; path: (locale: "en" | "fr") => string }[] = [
  { name: "login", who: "out", path: () => "/login" },
  { name: "forgot-password", who: "out", path: () => "/forgot-password" },
  { name: "mfa", who: "half", path: () => "/mfa" },
  { name: "mfa-setup", who: "setup", path: () => "/mfa/setup" },
  { name: "set-password", who: "in", path: () => "/set-password" },
  { name: "share", who: "out", path: (l) => `/s/${l}#${mintLink(l)}` },
];
function mintLink(locale: "en" | "fr") {
  const out = asUser(adminEmail, `select public.create_share_link('${leadId}', '${locale}', p_label => 'Phone', p_replace => true) ->> 'token'`);
  const token = out.split("\n").find((l) => /^tss_/.test(l));
  if (!token) throw new Error("no share token");
  return token;
}

// The app's own words, so each step finds its control in either language.
const messages = Object.fromEntries(
  (["en", "fr"] as const).map((l) => [l, JSON.parse(readFileSync(path.join(__dirname, "..", "..", "messages", `${l}.json`), "utf8"))]),
) as Record<"en" | "fr", Record<string, unknown>>;
function say(locale: "en" | "fr", key: string) {
  const text = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], messages[locale]);
  if (typeof text !== "string") throw new Error(`no message ${key}`);
  return text;
}

// The phone sheets and dialogs: how to open each one, and the layer that holds it.
type Sheet = {
  name: string;
  path: () => string;
  open: (page: Page, locale: "en" | "fr") => Promise<Locator>;
  close?: (page: Page, locale: "en" | "fr") => Promise<void>;
};
const topDialog = (page: Page) => page.locator("[role=dialog], [role=alertdialog]").last();
const sheets: Sheet[] = [
  {
    name: "add-lead",
    path: () => "/leads",
    open: async (page, l) => {
      await page.getByRole("button", { name: say(l, "Leads.add") }).first().click();
      return topDialog(page);
    },
  },
  {
    name: "new-deal",
    path: () => "/pipeline",
    open: async (page, l) => {
      await page.getByRole("button", { name: say(l, "Pipeline.newDeal") }).first().click();
      return topDialog(page);
    },
  },
  {
    name: "deal-sheet",
    path: () => "/pipeline",
    open: async (page) => {
      await page.locator("[data-deal-main]").first().click();
      return topDialog(page);
    },
  },
  {
    name: "lose",
    path: () => "/pipeline",
    open: async (page, l) => {
      await page.locator("[data-deal-main]").first().click();
      await topDialog(page).getByRole("button", { name: say(l, "Deals.sheet.markLost") }).click();
      return topDialog(page);
    },
  },
  {
    name: "note-sheet",
    path: () => `/leads/${leadId}`,
    open: async (page, l) => {
      await page.locator("main").getByRole("button", { name: say(l, "QuickActions.note"), exact: true }).first().click();
      return topDialog(page);
    },
  },
  {
    name: "call-panel",
    path: () => `/leads/${leadId}`,
    open: async (page, l) => {
      await page.locator("main").getByRole("link", { name: say(l, "QuickActions.call"), exact: true }).first().click();
      // Its tallest state: the call ended, the outcome keys and the note showing.
      await page.getByRole("button", { name: say(l, "CallPanel.end") }).click();
      await expect(page.locator("[data-outcome]").first()).toBeVisible();
      return page.getByRole("region").filter({ has: page.getByRole("button", { name: say(l, "CallPanel.close") }) });
    },
    // The call panel outlives a page change (it lives in the layout), so it is closed rather than left open: the first
    // close says "Call not logged", the second ends it.
    close: async (page, l) => {
      await page.getByRole("button", { name: say(l, "CallPanel.close") }).click();
      await page.getByRole("button", { name: say(l, "CallPanel.close") }).click();
    },
  },
  {
    name: "record-sale",
    path: () => "/inventory?tab=sales",
    open: async (page, l) => {
      await page.locator("main").getByRole("button", { name: say(l, "Sales.tab.recordSale") }).first().click();
      return topDialog(page);
    },
  },
  {
    name: "hold-stock",
    path: () => `/leads/${leadId}?tab=stock`,
    open: async (page, l) => {
      await page.locator("main").getByRole("button", { name: say(l, "Sales.tab.holdStock") }).first().click();
      return topDialog(page);
    },
  },
  {
    name: "palette",
    path: () => "/",
    open: async (page, l) => {
      await page.getByRole("button", { name: say(l, "Header.search") }).click();
      return topDialog(page);
    },
  },
];

function asUser(email: string, body: string) {
  const claims = `json_build_object('sub', '${userId(email)}', 'role', 'authenticated', 'aal', 'aal2', 'amr',
                   json_build_array(json_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint)))::text`;
  return sql(`begin; select set_config('request.jwt.claims', ${claims}, true); set local role authenticated; ${body}; commit;`);
}

// A few invented products in the run's org, with stock and one hold for a lead, through the app's own functions. Names
// no other spec uses: inventory.spec seeds its catalogue only when its marker product is missing from the stack.
function seedCatalogue(org: string) {
  const products = [
    { name: "Veste en jean délavée", cat: "Textile", ppc: 24, min: 9.5, max: 12.9, qty: 4200, reorder: 500 },
    { name: "Pull col roulé laine mérinos", cat: "Textile", ppc: 20, min: 14, max: 18.5, qty: 960, reorder: null },
    { name: "Valise cabine coque rigide 40 L", cat: "Bagagerie", ppc: 6, min: 24, max: 31, qty: 40, reorder: 100 },
    { name: "Enceinte Bluetooth étanche 20 W", cat: "Électronique", ppc: 30, min: 12.4, max: 16.9, qty: 0, reorder: null },
  ];
  for (const p of products) {
    asUser(
      adminEmail,
      `select public.create_product(p_name => '${p.name}', p_pieces_per_carton => ${p.ppc}, p_price_min => ${p.min}, p_price_max => ${p.max},
        p_category => '${p.cat}', p_reorder_point => ${p.reorder ?? "null"}, p_cost_per_piece => null, p_transit_eta => null,
        p_share_visible => true, p_opening_qty => ${p.qty || "null"}, p_opening_location => 'warehouse')`,
    );
  }
  const product = sql(`select id from public.products where org_id = '${org}' and name = 'Veste en jean délavée'`);
  asUser(adminEmail, `select public.post_stock_movement('${product}', 'reserve', 480, 'warehouse', p_company => '${leadId}')`);
  // Client links work in this org (the kill switch is off by default), for the client page's shots.
  asUser(adminEmail, `select public.set_sharing_enabled(true)`);
}

async function open(
  browser: Browser,
  o: { locale: "en" | "fr"; scheme?: "light" | "dark"; width?: number; who?: Who; motion?: "reduce" | "no-preference" },
) {
  const width = o.width ?? 390;
  const who = o.who ?? "in";
  const context = await browser.newContext({
    ...(who === "out" ? {} : { storageState: who === "half" ? halfState : who === "setup" ? setupState : state }),
    viewport: { width, height: width < 600 ? 844 : 900 },
    hasTouch: width < 600,
    // The client page's per-IP limit counts this run apart from the other specs (all from localhost).
    extraHTTPHeaders: who === "out" ? { "x-forwarded-for": "198.51.100.77" } : {},
    isMobile: false,
    colorScheme: o.scheme ?? "light",
    timezoneId: "Europe/Paris",
    reducedMotion: o.motion ?? "reduce",
  });
  const base = test.info().project.use.baseURL ?? "http://localhost:3100";
  await context.addCookies([{ name: "locale", value: o.locale, url: base }]);
  // tel:, mailto: and wa.me links would leave the page: the app's own click handlers still run (the call panel opens),
  // only the browser's navigation is stopped. Test-only.
  await context.addInitScript(() => {
    document.addEventListener(
      "click",
      (e) => {
        if ((e.target as Element | null)?.closest?.("a[href^='tel:'],a[href^='mailto:'],a[href^='https://wa.me/']")) e.preventDefault();
      },
      true,
    );
  });
  const page = await context.newPage();
  trackRequests(page);
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && !isCancelledPrefetch(m.text()) && errors.push(`${m.text()} (${m.location().url})`));
  page.on("pageerror", (e) => !isCancelledPrefetch(e.message) && errors.push(e.message));
  return { context, page, errors };
}

// A page outside the shell: its heading shown, nothing loading, no request in flight.
async function goPublic(page: Page, path: string) {
  await settled(page);
  await page.goto(path);
  await expect(page).toHaveURL((url) => url.pathname === path.split("#")[0]);
  await expect(page.locator("h1").first()).toBeVisible();
  await expect(page.locator("[aria-busy='true']").filter({ visible: true })).toHaveCount(0, { timeout: 15_000 });
  await settled(page);
}

async function go(page: Page, path: string) {
  await settled(page);
  await page.goto(path);
  await expect(page).toHaveURL((url) => `${url.pathname}${url.search}` === path);
  await expect(page.locator("main h1").first()).toBeVisible();
  await appReady(page);
  // Lists fill after the first paint (TanStack Query): wait for the skeletons to go.
  await expect(page.locator("main [aria-busy='true']").filter({ visible: true })).toHaveCount(0, { timeout: 15_000 });
  await settled(page);
}

type Problem = { what: string; target: string; size?: string };

// Measured in the page. A tap target is a link, button, form field or an element with a control's role. Its hit area
// is checked by hit-testing 21.5 px either side of its centre, across and down: each of the four points must land on
// the target (or inside it, or on its label). Inline links inside a sentence are exempt (WCAG 2.5.8), and so are
// elements nobody can see or reach (hidden, inert, aria-hidden, the 1 px visually hidden inputs behind custom controls).
async function fitProblems(page: Page, scope = "body"): Promise<{ problems: Problem[]; checked: number }> {
  return page.evaluate(async (scopeSelector) => {
    const problems: { what: string; target: string; size?: string }[] = [];
    const root = document.querySelector(scopeSelector) ?? document.body;
    const sideways = document.documentElement.scrollWidth - window.innerWidth;
    if (sideways > 0) problems.push({ what: "sideways scroll", target: `${sideways}px` });
    const name = (el: Element) => {
      const label = el.getAttribute("aria-label") || (el as HTMLElement).innerText || el.getAttribute("placeholder") || el.getAttribute("name") || "";
      return `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""} "${label.trim().replace(/\s+/g, " ").slice(0, 48)}"`;
    };
    const selector = [
      "a[href]",
      "button",
      "input:not([type=hidden])",
      "select",
      "textarea",
      "summary",
      "[role=button]",
      "[role=link]",
      "[role=tab]",
      "[role=checkbox]",
      "[role=radio]",
      "[role=switch]",
      "[role=menuitem]",
      "[role=option]",
      "[role=combobox]",
    ].join(",");
    const inlineInText = (el: Element) => {
      if (getComputedStyle(el).display !== "inline") return false;
      const parent = el.parentElement;
      return !!parent && [...parent.childNodes].some((n) => n !== el && n.nodeType === Node.TEXT_NODE && n.textContent!.trim().length > 0);
    };
    const targets = [...root.querySelectorAll<HTMLElement>(selector)].filter((el) => {
      if (el.closest("[aria-hidden='true'], [inert]")) return false;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2) return false; // visually hidden input behind a custom control
      const style = getComputedStyle(el);
      if (style.clipPath !== "none" || (style.clip !== "auto" && style.clip !== "")) return false; // shown on focus only (skip link)
      return !inlineInText(el);
    });
    let missed = "";
    const hits = (el: HTMLElement, x: number, y: number) => {
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return !(missed = "off screen");
      const at = document.elementFromPoint(x, y);
      if (!at) return !(missed = "nothing");
      if (el === at || el.contains(at)) return true;
      const label = at.closest("label");
      if (label && (label.contains(el) || (el.id !== "" && label.htmlFor === el.id))) return true;
      // The dock's bead sits on the current section's link and opens that section when tapped (aria-hidden on purpose).
      if (at.closest("[data-testid='dock-bead']") && el.getAttribute("aria-current") === "page") return true;
      missed = `${at.tagName.toLowerCase()}.${String(at.getAttribute("class") ?? "").split(" ").slice(0, 3).join(".")}`;
      return false;
    };
    for (const el of targets) {
      // A disabled control lets taps through (pointer-events), so only its box is measured.
      if (el.matches(":disabled, [aria-disabled='true']")) {
        const box = el.getBoundingClientRect();
        if (box.width < 44 || box.height < 44) problems.push({ what: "tap target under 44 px", target: name(el), size: `${box.width.toFixed(1)}x${box.height.toFixed(1)}, disabled` });
        continue;
      }
      el.scrollIntoView({ block: "center", inline: "center" });
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const r = el.getBoundingClientRect();
      // Chromium rounds a hit-test point to whole pixels, so the 44 pixels around a centre c are c - 22 to c + 21.
      const span = (c: number) => [Math.ceil(c - 22), Math.floor(c + 22) - 1];
      // A large target passes when a 44 px cross fits somewhere in it: its centre, or 22 px in from a corner (a card
      // whose middle holds a button of its own still has room to tap).
      const centres = [[r.left + r.width / 2, r.top + r.height / 2]];
      if (r.width > 66 || r.height > 66) {
        for (const x of [r.left + 22, r.right - 22]) for (const y of [r.top + 22, r.bottom - 22]) centres.push([x, y]);
      }
      let across = false;
      let down = false;
      for (const [cx, cy] of centres) {
        const [x1, x2] = span(cx);
        const [y1, y2] = span(cy);
        across = hits(el, x1, cy) && hits(el, x2, cy);
        down = hits(el, cx, y1) && hits(el, cx, y2);
        if (across && down) break;
      }
      if (!across || !down) {
        problems.push({ what: "tap target under 44 px", target: name(el), size: `${r.width.toFixed(1)}x${r.height.toFixed(1)}, ${!across ? "across" : "down"} hit ${missed}` });
      }
    }
    window.scrollTo(0, 0);
    return { problems, checked: targets.length };
  }, scope);
}

// French runs about 20 % longer (DESIGN.md: never fix label widths). A control's, heading's or term's (dt) own words are never cut:
// not by an ellipsis, not by a line clamp, and a field's placeholder fits its box (measured in the field's own font).
// Rows of a list (lead and product names, notes) may truncate data by design and are left to the screenshots.
async function cutLabels(page: Page, scope = "body"): Promise<Problem[]> {
  return page.evaluate((scopeSelector) => {
    const root = document.querySelector(scopeSelector) ?? document.body;
    const found: { what: string; target: string; size?: string }[] = [];
    const labelled = (el: Element) =>
      !!el.closest("button, [role=tab], [role=menuitem], [role=option], nav, h1, h2, h3, label, dt, [role=columnheader]") &&
      !(el.closest("li, [role=row], [role=listitem], [role=option]") && !el.closest("nav"));
    for (const el of root.querySelectorAll<HTMLElement>("*")) {
      if (el.clientWidth <= 2 || !el.checkVisibility({ visibilityProperty: true })) continue;
      const style = getComputedStyle(el);
      if (style.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1 && labelled(el)) {
        found.push({ what: "label cut", target: (el.innerText || "").trim().slice(0, 60), size: `${el.scrollWidth} > ${el.clientWidth}` });
      }
      const clamp = style.getPropertyValue("-webkit-line-clamp");
      if (clamp && clamp !== "none" && el.scrollHeight > el.clientHeight + 1 && labelled(el)) {
        found.push({ what: "label clamped", target: (el.innerText || "").trim().slice(0, 60), size: `${el.scrollHeight} > ${el.clientHeight}` });
      }
    }
    const canvas = document.createElement("canvas").getContext("2d")!;
    for (const field of root.querySelectorAll<HTMLInputElement>("input[placeholder]")) {
      if (!field.placeholder || field.value || field.clientWidth <= 2 || !field.checkVisibility({ visibilityProperty: true })) continue;
      const style = getComputedStyle(field);
      canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const text = canvas.measureText(field.placeholder).width;
      const box = field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      if (text > box + 1) found.push({ what: "placeholder cut", target: field.placeholder.slice(0, 60), size: `${Math.round(text)} > ${Math.round(box)}` });
    }
    return found;
  }, scope);
}

// The dock shows exactly the five phone sections (Master Plan 4), each visible.
async function dockLinks(page: Page): Promise<Problem[]> {
  const shown = await page.evaluate(
    () =>
      [...(document.querySelector("[data-testid='dock-bead']")?.closest("nav")?.querySelectorAll<HTMLElement>("a[href]") ?? [])].filter((a) =>
        a.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
      ).length,
  );
  return shown === 5 ? [] : [{ what: "dock links", target: `${shown} visible, 5 expected` }];
}

async function sideways(page: Page): Promise<Problem[]> {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  return over > 0 ? [{ what: "sideways scroll", target: `${over}px` }] : [];
}

// With the page scrolled to its end, the last content in <main> ends above the dock (the dock floats over the page).
async function underDock(page: Page): Promise<Problem[]> {
  return page.evaluate(async () => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    const dock = document.querySelector("nav[data-dock]") ?? document.querySelector("[data-testid='dock-bead']")?.closest("nav");
    const main = document.querySelector("main");
    if (!dock || !main) return [{ what: "dock or main missing", target: "" }];
    const dockTop = dock.getBoundingClientRect().top;
    let lowest = 0;
    let lowestName = "";
    for (const el of main.querySelectorAll<HTMLElement>("*")) {
      if (el.children.length > 0 && !el.matches("button, a, input, textarea, [role=button]")) continue;
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const style = getComputedStyle(el);
      if (style.position === "fixed" || el.closest("[data-sonner-toaster], [role=dialog]")) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.bottom > window.innerHeight + 1) continue;
      if (r.bottom > lowest) {
        lowest = r.bottom;
        lowestName = `${el.tagName.toLowerCase()} "${(el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 40)}"`;
      }
    }
    window.scrollTo(0, 0);
    return lowest > dockTop + 0.5 ? [{ what: "content under the dock", target: lowestName, size: `ends ${Math.round(lowest)}, dock ${Math.round(dockTop)}` }] : [];
  });
}

async function passwordOnly(browser: Browser, email: string, lands: RegExp) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(lands);
  const saved = await context.storageState();
  await context.close();
  return saved;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  if (SHOTS) mkdirSync(dir, { recursive: true });
  const secret = await createUser(adminEmail, password, true);
  await createUser(repEmail, password, false);
  const org = makeOrg(`Phone pass ${run}`);
  moveTo(adminEmail, org, "admin", "Haider");
  moveTo(repEmail, org, "rep", "Kais");
  seedHome(org, userId(adminEmail), userId(repEmail), "");
  leadId = sql(`select id from public.companies where org_id = '${org}' and name = 'Maison Verdane'`);
  sql(`update public.companies set phone = '06 12 34 56 78', email = 'achats@example.com' where id = '${leadId}'`);
  seedCatalogue(org);
  productId = sql(`select id from public.products where org_id = '${org}' and name = 'Veste en jean délavée'`);
  state = await fullSession(browser, adminEmail, password, secret);
  // Half signed in (password only) for /mfa, and the rep (no authenticator) for /mfa/setup.
  halfState = await passwordOnly(browser, adminEmail, /\/mfa$/);
  setupState = await passwordOnly(browser, repEmail, /\/mfa\/setup$/);
});

test("phone_fit: every route at 390 in EN and FR, and in French at 768 and 1280", async ({ browser }) => {
  const found: string[] = [];
  const note = (where: string, list: Problem[]) => {
    for (const p of list) found.push(`${where}: ${p.what}: ${p.target}${p.size ? ` (${p.size})` : ""}`);
  };
  for (const locale of ["en", "fr"] as const) {
    const { context, page, errors } = await open(browser, { locale });
    for (const route of routes) {
      await go(page, route.path());
      const fit = await fitProblems(page);
      // Not a vacuous pass: every route has at least the header's search and the dock's five links.
      expect(fit.checked, `${locale} ${route.name} targets checked`).toBeGreaterThanOrEqual(6);
      note(`${locale} 390 ${route.name}`, [...fit.problems, ...(await underDock(page)), ...(await cutLabels(page)), ...(await dockLinks(page))]);
    }
    await settled(page);
    expect(errors, `${locale} console errors`).toEqual([]);
    await context.close();
    for (const pg of publicPages) {
      const { context, page, errors } = await open(browser, { locale, who: pg.who });
      await goPublic(page, pg.path(locale));
      const fit = await fitProblems(page);
      expect(fit.checked, `${locale} ${pg.name} targets checked`).toBeGreaterThanOrEqual(1);
      note(`${locale} 390 ${pg.name}`, [...fit.problems, ...(await cutLabels(page))]);
      await settled(page);
      expect(errors, `${locale} ${pg.name} console errors`).toEqual([]);
      await context.close();
    }
  }
  // French at 768 and 1280: nothing scrolls sideways and nothing is cut (tap targets are a phone matter, checked above).
  for (const width of [768, 1280]) {
    const { context, page, errors } = await open(browser, { locale: "fr", width });
    for (const route of routes) {
      await go(page, route.path());
      note(`fr ${width} ${route.name}`, [...(await sideways(page)), ...(await cutLabels(page))]);
    }
    await settled(page);
    expect(errors, `fr ${width} console errors`).toEqual([]);
    await context.close();
    for (const pg of publicPages) {
      const { context, page, errors } = await open(browser, { locale: "fr", width, who: pg.who });
      await goPublic(page, pg.path("fr"));
      note(`fr ${width} ${pg.name}`, [...(await sideways(page)), ...(await cutLabels(page))]);
      await settled(page);
      expect(errors, `fr ${width} ${pg.name} console errors`).toEqual([]);
      await context.close();
    }
  }
  expect(found).toEqual([]);
});

// Closes a sheet (Escape, twice for the Lose dialog over the deal sheet) and waits until it has gone.
async function shut(page: Page, sheet: Sheet, locale: "en" | "fr", layer: Locator) {
  if (sheet.close) await sheet.close(page, locale);
  else {
    await page.keyboard.press("Escape");
    if (sheet.name === "lose") await page.keyboard.press("Escape");
  }
  await expect(layer).toBeHidden();
  await expect(page.locator("[role=dialog], [role=alertdialog]")).toHaveCount(0);
}

// Measured in the page: the layer's box inside the viewport.
async function outside(layer: Locator) {
  return layer.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const off = [r.left < -0.5 && "left", r.top < -0.5 && "top", r.right > window.innerWidth + 0.5 && "right", r.bottom > window.innerHeight + 0.5 && "bottom"].filter(Boolean);
    return off.length ? `${off.join(", ")} (${Math.round(r.left)}, ${Math.round(r.top)}, ${Math.round(r.right)}, ${Math.round(r.bottom)})` : "";
  });
}

test("phone_sheets: the phone sheets and dialogs fit a 390 screen in EN and FR, with 44 px targets", async ({ browser }) => {
  const found: string[] = [];
  for (const locale of ["en", "fr"] as const) {
    const { context, page, errors } = await open(browser, { locale });
    for (const sheet of sheets) {
      await go(page, sheet.path());
      const layer = await sheet.open(page, locale);
      await expect(layer).toBeVisible();
      await page.waitForTimeout(350); // the sheet's entrance (reduced motion: a fade)
      const off = await outside(layer);
      if (off) found.push(`${locale} ${sheet.name}: outside the screen: ${off}`);
      await layer.evaluate((el) => el.setAttribute("data-phone-scope", ""));
      const fit = await fitProblems(page, "[data-phone-scope]");
      expect(fit.checked, `${locale} ${sheet.name} targets checked`).toBeGreaterThanOrEqual(2);
      for (const p of [...fit.problems, ...(await cutLabels(page, "[data-phone-scope]"))]) found.push(`${locale} ${sheet.name}: ${p.what}: ${p.target}${p.size ? ` (${p.size})` : ""}`);
      await shut(page, sheet, locale, layer);
    }
    await settled(page);
    expect(errors, `${locale} console errors`).toEqual([]);
    await context.close();
  }
  expect(found).toEqual([]);
});

// The part-2 changes a desktop shows: the edge-faded strips (no fade where a strip fits, as on most desktops) and the
// tab strip after a deep link (revealTab). Each shot is clipped to the strip and its surroundings.
const strips: { name: string; who: Who; path: (l: "en" | "fr") => string; strip: (page: Page, l: "en" | "fr") => Locator }[] = [
  { name: "lead-tabs", who: "in", path: () => `/leads/${leadId}?tab=files`, strip: (page) => page.getByRole("tablist").first() },
  { name: "inventory-tabs", who: "in", path: () => "/inventory?tab=movements", strip: (page) => page.getByRole("tablist").first() },
  { name: "quick-add-chips", who: "in", path: () => "/tasks", strip: (page, l) => page.getByRole("group", { name: say(l, "Tasks.quickAdd.dateLabel") }) },
  { name: "share-chips", who: "out", path: (l) => `/s/${l}#${mintLink(l)}`, strip: (page, l) => page.getByRole("radiogroup", { name: say(l, "Share.categories") }) },
];

test("phone_shots: every route at 390 and 768, the sheets, and the desktop strips (DAY7C_PHONE=1)", async ({ browser }) => {
  test.skip(!SHOTS, "screenshots only with DAY7C_PHONE=1 (local evidence; CI runs the checks above)");
  const shot = async (page: Page, file: string, fullPage = true) => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${file} sideways`).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${dir}/${file}.png`, fullPage });
  };
  // 390: every signed-in route in EN and FR, light and dark; the pages outside the shell, the sheets and the lead's
  // tab strip after a deep link in two looks (English light, French dark).
  for (const locale of ["en", "fr"] as const) {
    for (const scheme of ["light", "dark"] as const) {
      const both = (locale === "en") === (scheme === "light");
      const { context, page, errors } = await open(browser, { locale, scheme });
      for (const route of routes) {
        await go(page, route.path());
        await page.waitForTimeout(300);
        await shot(page, `${route.name}-${locale}-${scheme}`);
      }
      if (both) {
        for (const sheet of sheets) {
          await go(page, sheet.path());
          const layer = await sheet.open(page, locale);
          await expect(layer).toBeVisible();
          await page.waitForTimeout(450);
          await shot(page, `sheet-${sheet.name}-${locale}-${scheme}`, false);
          await shut(page, sheet, locale, layer);
        }
        await go(page, `/leads/${leadId}?tab=files`);
        await page.waitForTimeout(300);
        await shot(page, `lead-tab-files-${locale}-${scheme}`, false);
      }
      await settled(page);
      expect(errors, `${locale} ${scheme} console errors`).toEqual([]);
      await context.close();
      if (both) {
        for (const pg of publicPages) {
          const pub = await open(browser, { locale, scheme, who: pg.who });
          await goPublic(pub.page, pg.path(locale));
          await shot(pub.page, `${pg.name}-${locale}-${scheme}`);
          await settled(pub.page);
          expect(pub.errors, `${pg.name} ${locale} ${scheme} console errors`).toEqual([]);
          await pub.context.close();
        }
      }
    }
  }
  // 768, French light: every route (French is the longer language; the layout changes from phone to tablet here).
  {
    const { context, page, errors } = await open(browser, { locale: "fr", width: 768 });
    for (const route of routes) {
      await go(page, route.path());
      await page.waitForTimeout(300);
      await shot(page, `768-${route.name}-fr-light`);
    }
    await settled(page);
    expect(errors).toEqual([]);
    await context.close();
    for (const pg of publicPages) {
      const pub = await open(browser, { locale: "fr", width: 768, who: pg.who });
      await goPublic(pub.page, pg.path("fr"));
      await shot(pub.page, `768-${pg.name}-fr-light`);
      await settled(pub.page);
      expect(pub.errors).toEqual([]);
      await pub.context.close();
    }
  }
  // Desktop: the strips at 1280, 1440 and 1728 in English light and French dark (both languages, both schemes).
  for (const [locale, scheme] of [["en", "light"], ["fr", "dark"]] as const) {
    for (const width of [1280, 1440, 1728]) {
      for (const strip of strips) {
        const { context, page, errors } = await open(browser, { locale, scheme, width, who: strip.who });
        if (strip.who === "out") await goPublic(page, strip.path(locale));
        else await go(page, strip.path(locale));
        const box = (await strip.strip(page, locale).boundingBox())!;
        expect(box, strip.name).not.toBeNull();
        const x = Math.max(0, box.x - 48);
        const y = Math.max(0, box.y - 48);
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${dir}/desktop-${strip.name}-${locale}-${scheme}-${width}.png`, clip: { x, y, width: Math.min(width - x, box.width + 96), height: box.height + 96 } });
        await settled(page);
        expect(errors, `${strip.name} ${width} console errors`).toEqual([]);
        await context.close();
      }
    }
  }
});

// From the top of the page, Tab through the page's own controls (the panel comes later in the order): each one ends above
// the call panel. Distinct controls are counted, so a Tab that went nowhere cannot pass.
async function tabAbovePanel(page: Page) {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("[data-tab-seen]")) el.removeAttribute("data-tab-seen");
    window.scrollTo(0, 0);
    (document.querySelector("main a[href], main button") as HTMLElement).focus({ preventScroll: true });
  });
  const hidden: string[] = [];
  let reached = 0;
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(60);
    const m = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      const panel = document.querySelector("[data-call-panel]")!.getBoundingClientRect();
      if (!el || !el.closest("main")) return null;
      const r = el.getBoundingClientRect();
      const fresh = !el.hasAttribute("data-tab-seen");
      el.setAttribute("data-tab-seen", "");
      return { fresh, name: (el.getAttribute("aria-label") || el.innerText || el.tagName).trim().slice(0, 40), bottom: r.bottom, top: r.top, panelTop: panel.top };
    });
    if (!m) break; // focus left the page's main area (dock, panel)
    if (!m.fresh) break; // Tab no longer moves on
    reached++;
    // A region taller than the room above the panel (a focusable tab panel) cannot fit whole: part of it shows.
    const tall = m.bottom - m.top > m.panelTop;
    if (tall ? m.top >= m.panelTop || m.bottom <= 0 : m.bottom > m.panelTop + 0.5 || m.top < 0) {
      hidden.push(`${m.name}: ${Math.round(m.top)}-${Math.round(m.bottom)}, panel at ${Math.round(m.panelTop)}`);
    }
  }
  return { reached, hidden };
}

// The height the page pads by equals the panel's laid-out height (offsetHeight), once its entrance has settled. The
// entrance scales the panel from 0.6 when motion is allowed, and a transform never fires a ResizeObserver, so a height
// read from getBoundingClientRect() at mount stayed about 40 % short for the whole call (advisor round 2).
async function panelHeightSettled(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const panel = document.querySelector<HTMLElement>("[data-call-panel]");
          const padded = getComputedStyle(document.documentElement).getPropertyValue("--call-panel-h").trim();
          // Math.ceil of the box height against offsetHeight's rounding: within 1 px is the same height.
          const gap = panel ? Math.abs(Number.parseFloat(padded) - panel.offsetHeight) : NaN;
          return gap <= 1 ? "settled" : panel ? `${padded} of ${panel.offsetHeight}px` : "no panel";
        }),
      { timeout: 3_000, message: "--call-panel-h follows the panel's layout height" },
    )
    .toBe("settled");
}

// With the call panel open on a phone, every page control reached with Tab ends above the panel: the panel stays
// non-modal (a call outlives page changes), so the page scrolls the focused control clear of it. Checked during the call
// (the small panel) and after it (the outcome keys, its tallest state), with reduced motion and without it (the panel
// then rises with a spring that scales it from 0.6).
for (const motion of ["reduce", "no-preference"] as const) {
  test(`phone_call_panel_tab (${motion} motion): with the call panel open, a control reached with Tab is not hidden under it`, async ({ browser }) => {
    const { context, page, errors } = await open(browser, { locale: "fr", motion });
    await go(page, `/leads/${leadId}`);
    await page.locator("main").getByRole("link", { name: say("fr", "QuickActions.call"), exact: true }).first().click();
    await expect(page.getByRole("button", { name: say("fr", "CallPanel.end") })).toBeVisible();
    await panelHeightSettled(page);
    const during = await tabAbovePanel(page);
    expect(during.reached, "controls reached with Tab during the call").toBeGreaterThanOrEqual(10);
    expect(during.hidden, "during the call").toEqual([]);
    await page.getByRole("button", { name: say("fr", "CallPanel.end") }).click();
    await expect(page.locator("[data-outcome]").first()).toBeVisible();
    await panelHeightSettled(page);
    const after = await tabAbovePanel(page);
    expect(after.reached, "controls reached with Tab after the call").toBeGreaterThanOrEqual(10);
    expect(after.hidden, "after the call").toEqual([]);
    await page.getByRole("button", { name: say("fr", "CallPanel.close") }).click();
    await page.getByRole("button", { name: say("fr", "CallPanel.close") }).click();
    await settled(page);
    expect(errors).toEqual([]);
    await context.close();
  });
}

// Safe areas on a notched phone (Chromium can emulate the insets; WebKit cannot): 390 x 844 with the status bar's 47 px
// and the home indicator's 34 px. The header starts below the status bar, the dock floats 16 px above the home
// indicator, nothing scrolls sideways, and the deal sheet's top clears the status bar.
test("phone_safe_areas: header below the status bar, dock above the home indicator, sheet below the notch", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "safe-area insets are emulated through Chromium's DevTools protocol");
  const found: string[] = [];
  const { context, page, errors } = await open(browser, { locale: "fr" });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride" as never, { insets: { top: 47, bottom: 34, left: 0, right: 0 } } as never);
  for (const route of routes) {
    await go(page, route.path());
    const m = await page.evaluate(() => {
      const dock = document.querySelector("[data-testid='dock-bead']")!.closest("nav")!.getBoundingClientRect();
      const header = document.querySelector("header")!.getBoundingClientRect();
      return { dockGap: window.innerHeight - dock.bottom, headerTop: header.top + window.scrollY, sideways: document.documentElement.scrollWidth - window.innerWidth };
    });
    if (m.dockGap < 16 + 34 - 0.5) found.push(`${route.name}: dock ${m.dockGap}px from the bottom`);
    if (m.headerTop < 47 - 0.5) found.push(`${route.name}: header at ${m.headerTop}px`);
    if (m.sideways > 0) found.push(`${route.name}: sideways scroll ${m.sideways}px`);
  }
  await go(page, "/pipeline");
  await page.locator("[data-deal-main]").first().click();
  const sheet = topDialog(page);
  await expect(sheet).toBeVisible();
  await page.waitForTimeout(350);
  const top = (await sheet.boundingBox())!.y;
  if (top < 47 - 0.5) found.push(`deal sheet top at ${top}px`);
  await page.keyboard.press("Escape");
  await settled(page);
  expect(errors).toEqual([]);
  await context.close();
  expect(found).toEqual([]);
});
