import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { appReady, countryInHours, createUser, fullSession, setRole, signedInPage, sql } from "./helpers";

// Three people work the queue at the same time (Day 4c, design 5.4 and 8.5 "queue-multi"): Haider, Henri and Kais (made-up
// test accounts) start together on 30 eligible unassigned leads with "Mine + unassigned". No lead is on two screens at
// once (every lead is shown to exactly one person: No answer sends it to the next working day, so it never comes back
// today), and every outcome lands once (one activity per lead). Checked in the database. Calling hours follow the real
// clock: the leads are put in a country in hours now, or the people use "Show leads outside calling hours".
test.describe.configure({ mode: "serial" });

const password = "Queue-Multi-Pass-42!";
const run = Date.now();
const people = ["Haider", "Henri", "Kais"].map((first) => ({ first, email: `queue-multi-${first.toLowerCase()}-${run}@example.test` }));
const states: Awaited<ReturnType<BrowserContext["storageState"]>>[] = [];
const open = countryInHours(true, 30);
const LEADS = 30;
const baseURL = () => test.info().project.use.baseURL ?? "http://localhost:3100";

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  for (const p of people) {
    const secret = await createUser(p.email, password, true);
    setRole(p.email, "admin");
    sql(`update public.profiles set first_name = '${p.first}', last_name = 'Multi', timezone = 'Europe/Paris'
         where id = (select id from auth.users where email = '${p.email}')`);
    states.push(await fullSession(browser, p.email, password, secret));
  }
  // Only this test's leads in the shared queue: every other lead without an owner leaves the queue (this local stack is
  // throwaway; other suites seed their own leads), then 30 unassigned, never-called leads.
  sql(`update public.companies set lead_status = 'disqualified' where owner_id is null and queue_rank is not null`);
  sql(`insert into public.companies (org_id, name, owner_id, lead_status, phone, city, country)
       select p.org_id, 'Multi ${run} ' || lpad(i::text, 2, '0'), null, 'cold', '+33 6 11 22 33 ' || lpad(i::text, 2, '0'), 'Testville', '${open ?? "FR"}'
       from public.profiles p, generate_series(1, ${LEADS}) i
       where p.id = (select id from auth.users where email = '${people[0].email}')`);
});

const card = (page: Page) => page.locator("main section[role=region]:not([data-leaving])");

async function work(page: Page, who: string, shown: Map<string, string>) {
  await page.goto("/leads/queue");
  await appReady(page);
  await page.getByRole("group", { name: "Whose leads" }).getByRole("button", { name: "Mine + unassigned" }).click();
  await page.getByRole("button", { name: "Start" }).click();
  if (!open) await page.getByRole("button", { name: "Show leads outside calling hours" }).click();
  const done = page.getByRole("heading", { name: "Everyone due has been called." });
  for (let i = 0; i < LEADS + 5; i++) {
    await expect(card(page).or(done)).toBeVisible({ timeout: 30_000 });
    if (await done.isVisible()) return;
    await expect(card(page)).toHaveCount(1);
    const name = ((await card(page).locator("h2").textContent()) ?? "").trim();
    // Seen by nobody else, ever: a lead is on one screen only.
    expect(shown.get(name), `${name} shown to ${who} and ${shown.get(name)}`).toBeUndefined();
    shown.set(name, who);
    await page.keyboard.press("1");
    // Gone from this screen (the next card, a loading card, or the end).
    await expect(card(page).locator("h2").filter({ hasText: new RegExp(`^${name}$`) })).toHaveCount(0, { timeout: 30_000 });
  }
}

test("three people, 30 leads: no lead on two screens, every outcome lands once", async ({ browser }) => {
  test.setTimeout(600_000);
  const pages = await Promise.all(states.map((state) => signedInPage(browser, state, { baseURL: baseURL() })));
  const shown = new Map<string, string>();
  await Promise.all(pages.map(({ page }, i) => work(page, people[i].first, shown)));
  expect(shown.size).toBe(LEADS);
  // Everyone got a share (claims are not handed out to one person only).
  const counts = people.map((p) => [...shown.values()].filter((w) => w === p.first).length);
  expect(counts.every((c) => c > 0), `shares ${counts.join(", ")}`).toBe(true);
  // One activity per lead, a No answer by the person who was shown it; no claim left over.
  await expect
    .poll(() =>
      sql(`select count(*) from public.activities a join public.companies c on c.id = a.company_id
           where c.name like 'Multi ${run} %'`),
    )
    .toBe(String(LEADS));
  expect(sql(`select count(*) from (select a.company_id from public.activities a join public.companies c on c.id = a.company_id
              where c.name like 'Multi ${run} %' group by a.company_id having count(*) <> 1) x`)).toBe("0");
  for (const [name, who] of shown) {
    expect(sql(`select p.first_name || ':' || a.outcome from public.activities a join public.companies c on c.id = a.company_id
                join public.profiles p on p.id = a.user_id where c.name = '${name}'`)).toBe(`${who}:no_answer`);
  }
  await expect
    .poll(() => sql(`select count(*) from private.queue_claims q join public.companies c on c.id = q.company_id where c.name like 'Multi ${run} %' and q.expires_at > now()`))
    .toBe("0");
  for (const { page, errors, context } of pages) {
    expect(errors).toEqual([]);
    await page.close();
    await context.close();
  }
});
