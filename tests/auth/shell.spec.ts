import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { appReady, createUser, fullSession, sql, twoFrames } from "./helpers";

// The app shell and dock (Day 2): sections open by tap, keyboard and bead drag; phones show five items.
test.describe.configure({ mode: "serial" });

const password = "Shell-Pass-42!";
const email = `shell-${Date.now()}@example.test`;
let state: Awaited<ReturnType<BrowserContext["storageState"]>>;

test.beforeAll(async ({ browser }) => {
  const secret = await createUser(email, password, true);
  state = await fullSession(browser, email, password, secret);
});

async function open(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator("main h1").first()).toBeVisible();
  await appReady(page);
}

function dock(page: Page) {
  return page.getByRole("navigation", { name: "Sections" });
}

async function beadSettledOver(page: Page, name: string) {
  const link = dock(page).getByRole("link", { name, exact: true });
  await expect
    .poll(async () => {
      const bead = await page.getByTestId("dock-bead").boundingBox();
      const box = await link.boundingBox();
      return bead && box ? Math.abs(bead.x + bead.width / 2 - (box.x + box.width / 2)) : 999;
    })
    .toBeLessThan(2);
}

// Every desktop width from CLAUDE.md, in Chromium and WebKit (Safari's engine).
for (const width of [1280, 1440, 1728]) test.describe(`desktop ${width}`, () => {
  const viewport = { width, height: 900 };

  test("seven sections; tap opens one and moves the bead there", async ({ browser }) => {
    const context = await browser.newContext({ storageState: state, viewport });
    const page = await context.newPage();
    await open(page, "/");
    await expect(page.locator("main h1")).toHaveText("Hello");
    const links = dock(page).getByRole("link");
    await expect(links).toHaveCount(7);
    for (const name of ["Home", "Leads", "Pipeline", "Inventory", "Tasks", "Analytics", "More"]) {
      await expect(dock(page).getByRole("link", { name, exact: true })).toBeVisible();
    }
    await expect(dock(page).getByRole("link", { name: "Home", exact: true })).toHaveAttribute("aria-current", "page");
    await beadSettledOver(page, "Home");

    await dock(page).getByRole("link", { name: "Leads", exact: true }).click();
    await expect(page).toHaveURL(/\/leads$/);
    await expect(page.locator("main h1")).toContainText("Leads");
    await expect(dock(page).getByRole("link", { name: "Leads", exact: true })).toHaveAttribute("aria-current", "page");
    await beadSettledOver(page, "Leads");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await context.close();
  });

  test("keyboard: arrows move between sections, Enter opens", async ({ browser }) => {
    const context = await browser.newContext({ storageState: state, viewport });
    const page = await context.newPage();
    await open(page, "/");
    // axe aria-hidden-focus on the dock: nothing hidden from assistive tech can take the keyboard focus (the bead).
    const hiddenFocusable = await dock(page).evaluate((nav) =>
      [...nav.querySelectorAll<HTMLElement>('[aria-hidden="true"]')]
        .flatMap((el) => [el, ...el.querySelectorAll<HTMLElement>("*")])
        .filter((el) => el.tabIndex >= 0 && (el.hasAttribute("tabindex") || el.matches("a[href],button,input,select,textarea")))
        .map((el) => el.outerHTML.slice(0, 80)),
    );
    expect(hiddenFocusable).toEqual([]);
    await dock(page).getByRole("link", { name: "Home", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(dock(page).getByRole("link", { name: "Pipeline", exact: true })).toBeFocused();
    await page.keyboard.press("End");
    await expect(dock(page).getByRole("link", { name: "More", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(dock(page).getByRole("link", { name: "Home", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/more$/);
    await context.close();
  });

  test("dragging the bead and letting go opens the section under it", async ({ browser }) => {
    const context = await browser.newContext({ storageState: state, viewport });
    const page = await context.newPage();
    await open(page, "/");
    await beadSettledOver(page, "Home");
    const bead = (await page.getByTestId("dock-bead").boundingBox())!;
    const target = (await dock(page).getByRole("link", { name: "Inventory", exact: true }).boundingBox())!;
    await page.mouse.move(bead.x + bead.width / 2, bead.y + bead.height / 2);
    await page.mouse.down();
    // Slow, even steps (no flick) so the drop point decides.
    const steps = 30;
    for (let i = 1; i <= steps; i++) {
      const xPos = bead.x + bead.width / 2 + ((target.x + target.width / 2 - (bead.x + bead.width / 2)) * i) / steps;
      await page.mouse.move(xPos, bead.y + bead.height / 2);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(150);
    await page.mouse.up();
    await expect(page).toHaveURL(/\/inventory$/);
    await expect(page.locator("main h1")).toContainText("Inventory"); // with products the heading also counts them (as Leads)
    await beadSettledOver(page, "Inventory");
    await context.close();
  });

  test("reduced motion: the bead lands at once", async ({ browser }) => {
    const context = await browser.newContext({ storageState: state, viewport, reducedMotion: "reduce" });
    const page = await context.newPage();
    await open(page, "/");
    const centre = async (name: string) => {
      const box = (await dock(page).getByRole("link", { name, exact: true }).boundingBox())!;
      return box.x + box.width / 2;
    };
    await beadSettledOver(page, "Home");
    const from = await centre("Home");
    const to = await centre("Analytics");
    // Record where the bead is on every frame from before the click until the new page has shown. No spring means it
    // is only ever over Home or over Analytics, never anywhere in between.
    await page.evaluate(() => {
      const bead = document.querySelector("[data-testid=dock-bead]")!;
      const store = window as unknown as { beadXs: number[] | null };
      const xs: number[] = [];
      store.beadXs = xs;
      const tick = () => {
        const r = bead.getBoundingClientRect();
        xs.push(r.x + r.width / 2);
        if (store.beadXs === xs) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await dock(page).getByRole("link", { name: "Analytics", exact: true }).click();
    await expect(page).toHaveURL(/\/analytics$/);
    await expect(page.locator("main h1")).toHaveText("Analytics");
    // The jump lands on a frame after the new page shows (Motion writes on its next frame, and a busy runner can take
    // longer than two): keep recording until the bead is over Analytics, then stop. A spring would leave positions in
    // between in the recording.
    await beadSettledOver(page, "Analytics");
    await twoFrames(page);
    const xs = await page.evaluate(() => {
      const store = window as unknown as { beadXs: number[] | null };
      const out = store.beadXs ?? [];
      store.beadXs = null;
      return out;
    });
    expect(xs.length).toBeGreaterThan(1);
    expect(xs.filter((x) => Math.abs(x - from) >= 2 && Math.abs(x - to) >= 2), "positions in between").toEqual([]);
    expect(Math.abs(xs[xs.length - 1] - to)).toBeLessThan(2);
    await context.close();
  });

  test("evidence: Home and the command menu", async ({ browser }, testInfo) => {
    const context = await browser.newContext({ storageState: state, viewport });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await open(page, "/");
    await beadSettledOver(page, "Home");
    const dir = `test-results/shell-screens/${testInfo.project.name}`;
    await page.screenshot({ path: `${dir}/home-${width}.png` });
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Command menu" })).toBeVisible();
    await page.waitForTimeout(250); // let the entrance settle before the shot
    await page.screenshot({ path: `${dir}/palette-${width}.png` });
    expect(errors).toEqual([]);
    await context.close();
  });
});

test("phone: five sections, Tasks and Analytics live under More", async ({ browser }) => {
  const context = await browser.newContext({ storageState: state, viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  await open(page, "/tasks");
  await expect(page.locator("main h1")).toHaveText("Tasks");
  const visible = dock(page).getByRole("link").filter({ visible: true });
  await expect(visible).toHaveCount(5);
  await expect(dock(page).getByRole("link", { name: "More", exact: true })).toHaveAttribute("aria-current", "page");
  await beadSettledOver(page, "More");
  // The bead covers the More icon here: tapping it opens More.
  await page.getByTestId("dock-bead").tap();
  await expect(page).toHaveURL(/\/more$/);
  await page.getByRole("main").getByRole("link", { name: "Analytics" }).click();
  await expect(page).toHaveURL(/\/analytics$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await context.close();
});

test.describe("keyboard and command menu", () => {
  test("Ctrl+K opens the command menu; searching and Enter opens the section", async ({ browser }) => {
    const context = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await open(page, "/");
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog", { name: "Command menu" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("combobox")).toBeFocused();
    await page.keyboard.type("pipe");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/pipeline$/);
    await expect(dialog).toBeHidden();

    // Ctrl+K again closes it (the typing field has focus while it is open).
    await page.keyboard.press("Control+k");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Control+k");
    await expect(dialog).toBeHidden();

    // "/" opens it too; Escape closes it and returns focus.
    await page.keyboard.press("/");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // Appearance from the menu.
    await page.getByRole("button", { name: "Search and commands" }).click();
    await page.keyboard.type("dark");
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveClass(/dark/);
    expect(errors).toEqual([]);
    await context.close();
  });

  test("in French, the command menu finds French words", async ({ browser }) => {
    const context = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 } });
    await context.addCookies([{ name: "locale", value: "fr", url: "http://localhost:3100" }]);
    const page = await context.newPage();
    await open(page, "/");
    await expect(page.locator("main h1")).toHaveText("Bonjour");
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog", { name: "Menu des commandes" });
    await expect(dialog).toBeVisible();
    await page.keyboard.type("sombre");
    await expect(dialog.getByRole("option", { name: "Apparence sombre" })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveClass(/dark/);
    // Straight away, while the menu is still fading out: Ctrl+K opens it again, with an empty search.
    await page.keyboard.press("Control+k");
    await expect(dialog.getByRole("combobox")).toHaveValue("");
    await page.keyboard.type("prosp");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/leads$/);
    await expect(page.locator("main h1")).toContainText("Prospects");
    await context.close();
  });

  test("G then L opens Leads; ? lists the shortcuts; typing in a field never triggers them", async ({ browser }) => {
    const context = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await open(page, "/");
    await page.keyboard.press("g");
    await page.keyboard.press("l");
    await expect(page).toHaveURL(/\/leads$/);

    await page.keyboard.press("Shift+Slash");
    const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(help).toBeVisible();
    await expect(help.getByText("Go to Inventory")).toBeVisible();
    // Focus starts on the list itself; Tab reaches the close button.
    await expect(help).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(help.getByRole("button", { name: "Close" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(help).toBeHidden();

    await open(page, "/more");
    const firstName = page.getByLabel("First name");
    await firstName.click();
    await page.keyboard.type("gl");
    await expect(page).toHaveURL(/\/more$/);
    await expect(firstName).toHaveValue(/gl$/);
    await context.close();
  });

  test("when the name cannot be read, More locks the form and Home hides the add-name link", async ({ browser }) => {
    const context = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    // Make the profile read fail for every signed-in user of the throwaway database, then put it back.
    sql("revoke select on public.profiles from authenticated");
    try {
      await open(page, "/more");
      await expect(page.getByRole("main").getByRole("alert")).toHaveText(
        "Couldn’t load your name just now. Reload the page to try again.",
      );
      await expect(page.getByLabel("First name")).toBeDisabled();
      await expect(page.getByRole("button", { name: "Save name" })).toBeDisabled();
      await open(page, "/");
      await expect(page.getByRole("link", { name: "Add your first name to the greeting" })).toHaveCount(0);
    } finally {
      sql("grant select on public.profiles to authenticated");
    }
    await context.close();
  });

  test("saving a first name puts it in the Home greeting", async ({ browser }) => {
    const context = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await open(page, "/");
    await expect(page.locator("main h1")).toHaveText("Hello");
    await page.getByRole("link", { name: "Add your first name to the greeting" }).click();
    await expect(page).toHaveURL(/\/more#profile$/);
    await page.getByLabel("First name").fill("Ada");
    await page.getByLabel("Last name").fill("Lovelace");
    await page.getByRole("button", { name: "Save name" }).click();
    await expect(page.getByRole("main").getByRole("status")).toHaveText("Saved.");
    await dockLink(page, "Home").click();
    await expect(page.locator("main h1")).toHaveText("Hello Ada");
    await context.close();
  });
});

function dockLink(page: Page, name: string) {
  return dock(page).getByRole("link", { name, exact: true });
}
