import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createUser, fullSession } from "./helpers";

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

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("seven sections; tap opens one and moves the bead there", async ({ browser }) => {
    const context = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 } });
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
    await expect(page.locator("main h1")).toHaveText("Leads");
    await expect(page.getByRole("heading", { name: "No leads yet" })).toBeVisible();
    await expect(dock(page).getByRole("link", { name: "Leads", exact: true })).toHaveAttribute("aria-current", "page");
    await beadSettledOver(page, "Leads");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await context.close();
  });

  test("keyboard: arrows move between sections, Enter opens", async ({ browser }) => {
    const context = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await open(page, "/");
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
    const context = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 } });
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
    await expect(page.locator("main h1")).toHaveText("Inventory");
    await beadSettledOver(page, "Inventory");
    await context.close();
  });

  test("reduced motion: the bead lands at once", async ({ browser }) => {
    const context = await browser.newContext({ storageState: state, viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    await open(page, "/");
    await dock(page).getByRole("link", { name: "Analytics", exact: true }).click();
    await expect(page).toHaveURL(/\/analytics$/);
    const link = dock(page).getByRole("link", { name: "Analytics", exact: true });
    // No spring: within one frame of the route change the bead is already over the new section.
    await expect(page.locator("main h1")).toHaveText("Analytics");
    const bead = (await page.getByTestId("dock-bead").boundingBox())!;
    const box = (await link.boundingBox())!;
    expect(Math.abs(bead.x + bead.width / 2 - (box.x + box.width / 2))).toBeLessThan(2);
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
    await page.keyboard.press("Escape");
    await expect(help).toBeHidden();

    await open(page, "/more");
    await page.getByLabel("First name").click();
    await page.keyboard.type("gl");
    await expect(page).toHaveURL(/\/more$/);
    await expect(page.getByLabel("First name")).toHaveValue(/gl$/);
    await context.close();
  });

  test("saving a first name puts it in the Home greeting", async ({ browser }) => {
    test.skip(!!process.env.LOCAL_AUTH_ONLY, "scripts/local-auth has no data API; CI runs this on the full Supabase stack");
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
