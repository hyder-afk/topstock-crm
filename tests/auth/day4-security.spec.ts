import { expect, test } from "@playwright/test";
import { appReady, createUser, fullSession, nextWindow, setRole, sql, totp } from "./helpers";

// Day 4 security checks that run on every Day 4 PR (design 8.5, "day4-security"), in their 4b scope: the undo records'
// private table is not served by the REST API; a rep's own token cannot change a colleague's entry; external links
// carry noopener and noreferrer; a server action sent from another origin is refused; error answers carry codes, never
// database text; the lead page logs no console error and no CSP violation. 4c adds the queue checks (rep scope, the
// private claims table, the release route). CI (auth-journey) runs real PostgREST; locally scripts/local-auth/gateway.mjs stands in, and the
// checks that hold only on real PostgREST are marked.
test.describe.configure({ mode: "serial" });

const password = "Day4-Security-Pass-42!";
const run = Date.now();
const adminEmail = `d4sec-admin-${run}@example.test`;
const repEmail = `d4sec-rep-${run}@example.test`;
let adminSecret = "";
let adminToken = "";
let repToken = "";
let realPostgrest = false;
let lead = "";
let adminState: Awaited<ReturnType<import("@playwright/test").BrowserContext["storageState"]>>;

function localEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see playwright.auth.config.ts)`);
  if (name.endsWith("_URL") && !["127.0.0.1", "localhost"].includes(new URL(v).hostname)) {
    throw new Error(`${name} must point at a local stack (127.0.0.1 or localhost)`);
  }
  return v;
}

type Init = { method?: string; token?: string; body?: unknown; headers?: Record<string, string> };
async function call(path: string, init: Init = {}) {
  const key = localEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const bearer = init.token ?? (key.startsWith("eyJ") ? key : undefined);
  const res = await fetch(`${localEnv("SUPABASE_LOCAL_URL")}${path}`, {
    method: init.method ?? "GET",
    headers: {
      apikey: key,
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function auth(path: string, init: Init) {
  const r = await call(`/auth/v1${path}`, { method: "POST", ...init });
  if (r.status >= 400) throw new Error(`${path} failed: ${r.status}`);
  return r.body as Record<string, unknown>;
}

async function aal2Token(email: string, secret: string) {
  const { access_token: token } = (await auth("/token?grant_type=password", { body: { email, password } })) as { access_token: string };
  const user = (await auth("/user", { method: "GET", token })) as { factors?: { id: string; factor_type: string; status: string }[] };
  const factor = user.factors?.find((f) => f.factor_type === "totp" && f.status === "verified");
  if (!factor) throw new Error(`no verified authenticator for ${email}`);
  const challenge = (await auth(`/factors/${factor.id}/challenge`, { token, body: {} })) as { id: string };
  const verified = (await auth(`/factors/${factor.id}/verify`, { token, body: { challenge_id: challenge.id, code: totp(secret) } })) as {
    access_token: string;
  };
  return verified.access_token;
}

const userId = (email: string) => sql(`select id from auth.users where email = '${email}'`);

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  adminSecret = await createUser(adminEmail, password, true);
  const repSecret = await createUser(repEmail, password, true);
  setRole(adminEmail, "admin");
  setRole(repEmail, "rep");
  lead = sql(`insert into public.companies (org_id, name, owner_id, lead_status, phone, email, city, country)
              select org_id, 'Sécurité Textiles', id, 'cold', '06 12 34 56 78', 'achats@example.com', 'Lyon', 'FR'
              from public.profiles where id = '${userId(adminEmail)}' returning id`);
  await nextWindow();
  adminToken = await aal2Token(adminEmail, adminSecret);
  repToken = await aal2Token(repEmail, repSecret);
  const probe = await call("/rest/v1/companies?select=id&limit=1", { token: adminToken });
  realPostgrest = !(probe.status === 400 && (probe.body as { code?: string } | null)?.code === "LOCAL");
  if (process.env.CI) expect(realPostgrest, "CI runs real PostgREST").toBe(true);
  adminState = await fullSession(browser, adminEmail, password, adminSecret);
});

test("private_tables_not_exposed: undo records are not served by the REST API", async () => {
  const logged = await call("/rest/v1/rpc/log_activity", {
    method: "POST",
    token: adminToken,
    body: { p_company: lead, p_type: "call", p_outcome: "no_answer", p_dialled: "lead" },
  });
  expect(logged.status).toBe(200);
  const activity = (logged.body as { activity_id: string }).activity_id;
  expect(sql(`select count(*) from private.activity_undo where activity_id = '${activity}'`)).toBe("1");
  // As a public table it does not exist: 404 on both servers, never rows.
  const plain = await call("/rest/v1/activity_undo?select=activity_id", { token: adminToken });
  expect(plain.status).toBe(404);
  expect(Array.isArray(plain.body)).toBe(false);
  // Asking for the private schema by name: refused by real PostgREST (406, the schema is not exposed).
  const named = await call("/rest/v1/activity_undo?select=activity_id", { token: adminToken, headers: { "Accept-Profile": "private" } });
  expect(Array.isArray(named.body)).toBe(false);
  if (realPostgrest) expect(named.status).toBe(406);
  else expect(named.status).toBeGreaterThanOrEqual(400);
});

test("rep_direct_rpc: a rep's own token cannot edit or delete a colleague's entry, nor log as someone else", async () => {
  const logged = await call("/rest/v1/rpc/log_activity", {
    method: "POST",
    token: adminToken,
    body: { p_company: lead, p_type: "note", p_body: "Admin's words" },
  });
  const activity = (logged.body as { activity_id: string }).activity_id;
  const edit = await call("/rest/v1/rpc/edit_activity", { method: "POST", token: repToken, body: { p_id: activity, p_body: "Rewritten" } });
  expect(edit.status).toBe(403);
  expect((edit.body as { hint?: string }).hint).toBe("not_editable");
  const del = await call("/rest/v1/rpc/delete_activity", { method: "POST", token: repToken, body: { p_id: activity } });
  expect(del.status).toBe(403);
  expect(sql(`select body from public.activities where id = '${activity}'`)).toBe("Admin's words");
  // The author column cannot be sent: the function has no such parameter (PostgREST: 404, the stand-in: no match).
  const forged = await call("/rest/v1/rpc/log_activity", {
    method: "POST",
    token: repToken,
    body: { p_company: lead, p_type: "note", p_body: "x", p_user_id: userId(adminEmail) },
  });
  if (realPostgrest) expect(forged.status).toBe(404);
  expect(sql(`select count(*) from public.activities where company_id = '${lead}' and user_id = '${userId(adminEmail)}' and body = 'x'`)).toBe("0");
});

test("external_links_rel, no console errors and no CSP violations on the lead page", async ({ browser }) => {
  const context = await browser.newContext({ storageState: adminState, viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber} ${e.sample}`),
    );
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/leads/${lead}`);
  await expect(page.locator("main h1")).toHaveText("Sécurité Textiles");
  await appReady(page);
  for (const tab of ["Timeline", "Deals", "Stock", "Details", "Summary"]) {
    await page.getByRole("tab", { name: tab }).click();
    await expect(page.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
  }
  // Every link that opens elsewhere keeps the page out of reach; dialling links hold digits and a plus only.
  const blank = await page.locator("a[target=_blank]").evaluateAll((els) => els.map((a) => a.getAttribute("rel") ?? ""));
  expect(blank.length).toBeGreaterThan(0);
  for (const rel of blank) {
    expect(rel).toContain("noopener");
    expect(rel).toContain("noreferrer");
  }
  for (const href of await page.locator("a[href^='tel:']").evaluateAll((els) => els.map((a) => a.getAttribute("href") ?? ""))) {
    expect(href).toMatch(/^tel:\+?\d+$/);
  }
  for (const href of await page.locator("a[href^='https://wa.me/']").evaluateAll((els) => els.map((a) => a.getAttribute("href") ?? ""))) {
    expect(href).toMatch(/^https:\/\/wa\.me\/\d+$/);
  }
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
  expect(errors).toEqual([]);
  await context.close();
});

test("cross_site_action_refused: a server action sent with another Origin changes nothing", async ({ browser }) => {
  const context = await browser.newContext({ storageState: adminState, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`/leads/${lead}`);
  await appReady(page);
  const before = sql(`select count(*) from public.activities where company_id = '${lead}'`);
  // The browser's own Save is captured and stopped (the connection seems lost), then replayed exactly, except for the
  // Origin, as a page on another site would send it with this person's cookies. A browser cannot be made to send a
  // foreign Origin from this page itself (Chromium ignores an Origin override), so the replay goes through the
  // context's request client, which carries the same session cookies.
  let captured: { headers: Record<string, string>; body: string } | null = null;
  await page.route(`**/leads/${lead}`, async (route) => {
    const request = route.request();
    if (request.method() === "POST" && request.headers()["next-action"] && !captured) {
      captured = { headers: request.headers(), body: request.postData() ?? "" };
      await route.abort();
    } else {
      await route.continue();
    }
  });
  const composer = page.getByRole("form", { name: "Log activity" });
  await composer.getByRole("textbox", { name: "Note" }).fill("From another site");
  await composer.getByRole("button", { name: /^Save to timeline/ }).click();
  // error_copy_has_no_sql: the screen says what to do, in words, without database text; the note is kept.
  const toast = page.getByRole("status").filter({ hasText: /\S/ }).last();
  await expect(toast).toContainText("Couldn’t save just now");
  await expect(toast).not.toContainText(/select|insert|update|delete|violat|constraint|sql|postgres|42501|22023/i);
  await expect(composer.getByRole("textbox", { name: "Note" })).toHaveValue("From another site");
  expect(captured).not.toBeNull();
  const { headers, body } = captured as unknown as { headers: Record<string, string>; body: string };
  // Each replay gets a request id of its own (the body's one UUID that is not the lead's), so the database cannot
  // answer it as a replay of an earlier one: a row appears exactly when the action ran.
  const ids = [...new Set(body.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [])].filter((id) => id !== lead);
  expect(ids).toHaveLength(1);
  const withNewRequest = () => body.split(ids[0]).join(crypto.randomUUID());
  // First the same request with the page's own Origin: it runs (proves the replay itself is sound).
  expect(headers.origin).toBe(new URL(page.url()).origin);
  const same = await context.request.post(`/leads/${lead}`, { headers, data: withNewRequest(), maxRedirects: 0 });
  expect(same.status()).toBe(200);
  const after = String(Number(before) + 1);
  expect(sql(`select count(*) from public.activities where company_id = '${lead}'`)).toBe(after);
  // Then with another site's Origin: refused, and nothing more is written.
  const replay = await context.request.post(`/leads/${lead}`, {
    headers: { ...headers, origin: "https://evil.example" },
    data: withNewRequest(),
    maxRedirects: 0,
  });
  expect(replay.status()).toBe(500);
  expect(sql(`select count(*) from public.activities where company_id = '${lead}'`)).toBe(after);
  await context.close();
});

test("error_copy_has_no_sql: the lead page APIs answer codes only", async ({ browser }) => {
  const context = await browser.newContext({ storageState: adminState });
  const missing = "00000000-0000-4000-8000-000000000000";
  const answers = [
    await context.request.get(`/api/activities/${missing}`),
    await context.request.get(`/api/leads/${lead}/activities?before_at=not-a-time&before_id=${missing}`),
    await context.request.get(`/api/leads/not-a-uuid/tasks`),
  ];
  expect(answers.map((a) => a.status())).toEqual([404, 400, 400]);
  for (const a of answers) {
    expect(Object.keys(await a.json())).toEqual(["error"]);
    expect(a.headers()["cache-control"]).toContain("no-store");
  }
  await context.close();
});

// Day 4c: the queue's checks (design 6, threats 13, 15 and 28).
test("rep_direct_rpc_scope_403: a rep's own token cannot work the team's queue or claim a colleague's lead", async () => {
  for (const fn of ["claim_next_lead", "queue_summary"]) {
    for (const scope of ["team", "mine_unassigned"]) {
      const r = await call(`/rest/v1/rpc/${fn}`, { method: "POST", token: repToken, body: { p_scope: scope } });
      expect(r.status, `${fn} ${scope}`).toBe(403);
      expect((r.body as { hint?: string }).hint).toBe("scope");
    }
  }
  const claim = await call("/rest/v1/rpc/claim_lead", { method: "POST", token: repToken, body: { p_company: lead } });
  expect(claim.status).toBe(403);
  expect(sql(`select count(*) from private.queue_claims where company_id = '${lead}' and user_id = '${userId(repEmail)}'`)).toBe("0");
  const tasks = await call("/rest/v1/rpc/list_tasks", { method: "POST", token: repToken, body: { p_bucket: "today", p_scope: "team" } });
  expect(tasks.status).toBe(403);
});

test("private_tables_not_exposed: queue claims are not served by the REST API", async () => {
  const claimed = await call("/rest/v1/rpc/claim_lead", { method: "POST", token: adminToken, body: { p_company: lead } });
  expect(claimed.status).toBe(200);
  expect(sql(`select count(*) from private.queue_claims where company_id = '${lead}'`)).toBe("1");
  const plain = await call("/rest/v1/queue_claims?select=company_id", { token: adminToken });
  expect(plain.status).toBe(404);
  expect(Array.isArray(plain.body)).toBe(false);
  const named = await call("/rest/v1/queue_claims?select=company_id", { token: adminToken, headers: { "Accept-Profile": "private" } });
  expect(Array.isArray(named.body)).toBe(false);
  if (realPostgrest) expect(named.status).toBe(406);
  else expect(named.status).toBeGreaterThanOrEqual(400);
  await call("/rest/v1/rpc/release_claims", { method: "POST", token: adminToken, body: {} });
  expect(sql(`select count(*) from private.queue_claims where company_id = '${lead}'`)).toBe("0");
});

test("cross_origin_release_403: the release route takes same-origin JSON only, and releases only the caller's claims", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ storageState: adminState });
  const origin = new URL(baseURL ?? "http://localhost:3100").origin;
  // The admin holds a claim (through the API, as the queue does).
  const claimed = await call("/rest/v1/rpc/claim_lead", { method: "POST", token: adminToken, body: { p_company: lead } });
  expect(claimed.status).toBe(200);
  const live = () => sql(`select count(*) from private.queue_claims where company_id = '${lead}'`);
  expect(live()).toBe("1");
  // Another site's page: 403, the claim stays.
  const foreign = await context.request.post("/api/queue/release", { headers: { origin: "https://evil.example", "content-type": "application/json" }, data: { ids: [lead] } });
  expect(foreign.status()).toBe(403);
  expect(await foreign.json()).toEqual({ error: "forbidden" });
  expect(foreign.headers()["cache-control"]).toContain("no-store");
  // A form post (no preflight from another site) and an oversized body: refused.
  const form = await context.request.post("/api/queue/release", { headers: { origin, "content-type": "application/x-www-form-urlencoded" }, data: `ids=${lead}` });
  expect(form.status()).toBe(415);
  const big = await context.request.post("/api/queue/release", { headers: { origin, "content-type": "application/json" }, data: JSON.stringify({ ids: [lead], pad: "x".repeat(40_000) }) });
  expect(big.status()).toBe(413);
  const extra = await context.request.post("/api/queue/release", { headers: { origin, "content-type": "application/json" }, data: { ids: [lead], user_id: userId(repEmail) } });
  expect(extra.status()).toBe(400);
  expect(live()).toBe("1");
  // The rep, from this site, cannot release the admin's claim (release_claims removes the caller's own only).
  const repSession = await call("/rest/v1/rpc/release_claims", { method: "POST", token: repToken, body: { p_ids: [lead] } });
  expect(repSession.status).toBe(200);
  expect(repSession.body).toBe(0);
  expect(live()).toBe("1");
  // Signed out: 401. The admin from this site: released.
  const anonymous = await browser.newContext();
  const out = await anonymous.request.post("/api/queue/release", { headers: { origin, "content-type": "application/json" }, data: { ids: [lead] } });
  expect(out.status()).toBe(401);
  await anonymous.close();
  const same = await context.request.post("/api/queue/release", { headers: { origin, "content-type": "application/json" }, data: { ids: [lead] } });
  expect(same.status()).toBe(200);
  expect(await same.json()).toEqual({ released: 1 });
  expect(live()).toBe("0");
  // The key-press routes (design D3's switch): another site's page gets 403 and nothing is written or claimed.
  const before = sql(`select count(*) from public.activities where company_id = '${lead}'`);
  const outcome = {
    log: { leadId: lead, type: "call", outcome: "no_answer", body: "", contactId: null, dialled: "lead", followUpDate: null, followUpAt: null, leadName: "x", requestId: crypto.randomUUID() },
    next: null,
  };
  const foreignOutcome = await context.request.post("/api/queue/outcome", { headers: { origin: "https://evil.example", "content-type": "application/json" }, data: outcome });
  expect(foreignOutcome.status()).toBe(403);
  const foreignNext = await context.request.post("/api/queue/next", {
    headers: { origin: "https://evil.example", "content-type": "application/json" },
    data: { next: { scope: "mine", keep: [], exclude: [], anyHours: true, skipLunch: false } },
  });
  expect(foreignNext.status()).toBe(403);
  expect(sql(`select count(*) from public.activities where company_id = '${lead}'`)).toBe(before);
  expect(sql(`select count(*) from private.queue_claims where user_id = '${userId(adminEmail)}'`)).toBe("0");
  // A field the route does not know is refused (no mass assignment), answered with a code.
  const extraField = await context.request.post("/api/queue/outcome", { headers: { origin, "content-type": "application/json" }, data: { ...outcome, userId: userId(repEmail) } });
  expect(await extraField.json()).toEqual({ ok: false, error: "invalid", hint: "outcome" });
  // The same request from this site is saved (proves the refusals above were the origin's).
  const sameOutcome = await context.request.post("/api/queue/outcome", { headers: { origin, "content-type": "application/json" }, data: outcome });
  expect(sameOutcome.status()).toBe(200);
  expect(((await sameOutcome.json()) as { ok: boolean }).ok).toBe(true);
  expect(sql(`select count(*) from public.activities where company_id = '${lead}'`)).toBe(String(Number(before) + 1));
  await context.close();
});

test("no console errors and no CSP violations on the Tasks page, the queue and More (4c)", async ({ browser }) => {
  const context = await browser.newContext({ storageState: adminState, viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber} ${e.sample}`),
    );
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/tasks");
  await expect(page.locator("main h1")).toContainText("Tasks");
  await appReady(page);
  for (const name of [/^Overdue/, /^Upcoming/, /^Done/, /^Today/]) await page.getByRole("tab", { name }).click();
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
  await page.goto("/leads/queue");
  await expect(page.locator("main h1")).toContainText("Work queue");
  await appReady(page);
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.locator("main section[role=region], main [role=status] h2").first()).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
  await page.goto("/more");
  await expect(page.getByRole("combobox", { name: "Time zone" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
  expect(errors).toEqual([]);
  await context.close();
});
