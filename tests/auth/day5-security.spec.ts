import { expect, test } from "@playwright/test";
import { appReady, createUser, fullSession, nextWindow, setRole, sql, totp } from "./helpers";

// Day 5 security checks that run on every Day 5 PR (design 8.5 "day5-security.spec.ts", threat table section 6): a
// rep's own token cannot read the team's deals or another person's deal; the stage history, the stages and the
// server's deal columns cannot be written through the REST API; the private move records are not served; a server
// action sent from another origin moves nothing; error answers carry codes, never database text; the pipeline logs no
// console error and no CSP violation. CI (auth-journey) runs real PostgREST; locally scripts/local-auth/gateway.mjs
// stands in (rpc calls, table GET and PATCH only), so the checks that hold only on real PostgREST are marked, and every
// check also reads the database to prove nothing changed.
test.describe.configure({ mode: "serial" });

const password = "Day5-Security-Pass-42!";
const run = Date.now();
const adminEmail = `d5sec-admin-${run}@example.test`;
const repEmail = `d5sec-rep-${run}@example.test`;
let adminToken = "";
let repToken = "";
let realPostgrest = false;
let org = "";
let admin = "";
let lead = "";
let deal = "";
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
const dealRow = () =>
  sql(`select s.key || '|' || d.status || '|' || d.version || '|' || coalesce(d.value::text, '') from public.deals d
         join public.pipeline_stages s on s.id = d.stage_id where d.id = '${deal}'`);
const noSql = /select|insert|update|delete|violat|constraint|sql|postgres|relation|column|42501|22023|P0002/i;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  const adminSecret = await createUser(adminEmail, password, true);
  const repSecret = await createUser(repEmail, password, true);
  setRole(adminEmail, "admin");
  setRole(repEmail, "rep");
  admin = userId(adminEmail);
  org = sql(`select org_id from public.profiles where id = '${admin}'`);
  lead = sql(`insert into public.companies (org_id, name, owner_id, lead_status, phone, city, country)
              values ('${org}', 'Sécurité Deals ${run}', '${admin}', 'warm', '06 12 34 56 78', 'Lyon', 'FR') returning id`);
  deal = sql(`insert into public.deals (org_id, company_id, stage_id, owner_id, created_by, title, value, stage_entered_at, version)
              select '${org}', '${lead}', s.id, '${admin}', '${admin}', 'Admin deal ${run}', 9000, now(), 0
                from public.pipeline_stages s where s.org_id = '${org}' and s.key = 'qualified' returning id`);
  await nextWindow();
  adminToken = await aal2Token(adminEmail, adminSecret);
  repToken = await aal2Token(repEmail, repSecret);
  const probe = await call("/rest/v1/companies?select=id&limit=1", { token: adminToken });
  realPostgrest = !(probe.status === 400 && (probe.body as { code?: string } | null)?.code === "LOCAL");
  if (process.env.CI) expect(realPostgrest, "CI runs real PostgREST").toBe(true);
  adminState = await fullSession(browser, adminEmail, password, adminSecret);
});

test("rep_direct_rpc_team_scope_403: a rep's own token cannot list the team's deals or another person's", async () => {
  for (const [fn, body] of [
    ["list_stage_deals", { p_stage: "qualified", p_scope: "team" }],
    ["pipeline_summary", { p_scope: "team" }],
    ["list_stage_deals", { p_stage: "qualified", p_scope: "mine", p_owner: admin }],
  ] as const) {
    const r = await call(`/rest/v1/rpc/${fn}`, { method: "POST", token: repToken, body });
    expect(r.status, fn).toBe(403);
    expect((r.body as { hint?: string }).hint, fn).toBe("scope");
  }
  // The board answers a rep's "team" with their own deals only (D21): the admin's deal is not in it.
  const board = await call("/rest/v1/rpc/pipeline_board", { method: "POST", token: repToken, body: { p_scope: "team" } });
  expect(board.status).toBe(200);
  expect(JSON.stringify(board.body)).not.toContain(deal);
});

test("rep_get_other_deal_404: another person's deal reads as missing, the same as one that does not exist", async ({ browser }) => {
  const other = await call("/rest/v1/rpc/get_deal", { method: "POST", token: repToken, body: { p_id: deal } });
  const missing = await call("/rest/v1/rpc/get_deal", { method: "POST", token: repToken, body: { p_id: "00000000-0000-4000-8000-000000000000" } });
  // get_deal answers SQL null for both (204 from PostgREST and the stand-in): the deal's existence is not revealed.
  expect(other.status).toBe(missing.status);
  expect(other.body).toEqual(missing.body);
  expect(JSON.stringify(other.body ?? "")).not.toContain("Admin deal");
  // The rep cannot move it either: the version check never sees it (no row), nothing changes.
  const before = dealRow();
  const moved = await call("/rest/v1/rpc/move_deal", { method: "POST", token: repToken, body: { p_id: deal, p_stage: "negotiations", p_expected_version: 0 } });
  expect(moved.status).toBeGreaterThanOrEqual(400);
  expect(dealRow()).toBe(before);
  // Through the app's own route: 404, codes only.
  const adminContext = await browser.newContext({ storageState: adminState });
  const mine = await adminContext.request.get(`/api/deals/${deal}`);
  expect(mine.status()).toBe(200);
  const none = await adminContext.request.get(`/api/deals/00000000-0000-4000-8000-000000000000`);
  expect(none.status()).toBe(404);
  expect(await none.json()).toEqual({ error: "not_found" });
  await adminContext.close();
});

test("history_table_write_refused, stage_write_refused_via_rest, deal_patch_status_column_denied, private_deal_moves_not_exposed", async () => {
  const history = sql(`select count(*) from public.deal_stage_history where deal_id = '${deal}'`);
  const stageNames = sql(`select string_agg(key || ':' || stall_days::text, ',' order by position) from public.pipeline_stages where org_id = '${org}'`);
  // The history is the database's own record: no insert through the API (PostgREST 403 from the missing insert grant;
  // the stand-in has no table inserts at all), and no row appears. The body is a row the table would accept (real
  // columns, values its checks allow), so the refusal is the privilege itself: a column the table does not have is
  // refused earlier by PostgREST's schema cache (400 PGRST204) and proves nothing about the grant.
  const insert = await call("/rest/v1/deal_stage_history", {
    method: "POST",
    token: adminToken,
    body: { org_id: org, deal_id: deal, actor_id: admin, kind: "move", from_stage: "qualified", to_stage: "negotiations", version_after: 1 },
  });
  expect(insert.status, JSON.stringify(insert.body)).toBeGreaterThanOrEqual(400);
  if (realPostgrest) {
    expect(insert.status, JSON.stringify(insert.body)).toBe(403);
    expect((insert.body as { code?: string } | null)?.code, JSON.stringify(insert.body)).toBe("42501");
  }
  const historyPatch = await call(`/rest/v1/deal_stage_history?deal_id=eq.${deal}`, { method: "PATCH", token: adminToken, body: { kind: "won" } });
  expect(historyPatch.status).toBe(403);
  expect(sql(`select count(*) from public.deal_stage_history where deal_id = '${deal}'`)).toBe(history);
  // Stages are the server's: an admin's PATCH is refused (no update grant).
  const stagePatch = await call(`/rest/v1/pipeline_stages?org_id=eq.${org}`, { method: "PATCH", token: adminToken, body: { stall_days: 1 } });
  expect(stagePatch.status).toBe(403);
  expect(sql(`select string_agg(key || ':' || stall_days::text, ',' order by position) from public.pipeline_stages where org_id = '${org}'`)).toBe(stageNames);
  // Status, version and the stage clock are not in the update grant: the owner's own PATCH is refused whole.
  const before = dealRow();
  for (const body of [{ status: "won" }, { version: 99 }, { stage_entered_at: "2020-01-01T00:00:00Z" }, { created_by: userId(repEmail) }]) {
    const r = await call(`/rest/v1/deals?id=eq.${deal}`, { method: "PATCH", token: adminToken, body });
    expect(r.status, JSON.stringify(body)).toBe(403);
  }
  expect(dealRow()).toBe(before);
  // The private move records (the Undo of a move) are not a public table: 404, and by schema name refused.
  const moved = await call("/rest/v1/rpc/move_deal", {
    method: "POST",
    token: adminToken,
    body: { p_id: deal, p_stage: "negotiations", p_expected_version: 0, p_request_id: crypto.randomUUID() },
  });
  expect(moved.status).toBe(200);
  expect(sql(`select count(*) from private.deal_moves where deal_id = '${deal}'`)).toBe("1");
  const plain = await call("/rest/v1/deal_moves?select=deal_id", { token: adminToken });
  expect(plain.status).toBe(404);
  expect(Array.isArray(plain.body)).toBe(false);
  const named = await call("/rest/v1/deal_moves?select=deal_id", { token: adminToken, headers: { "Accept-Profile": "private" } });
  expect(Array.isArray(named.body)).toBe(false);
  if (realPostgrest) expect(named.status).toBe(406);
  else expect(named.status).toBeGreaterThanOrEqual(400);
});

test("cross_site_move_action_refused: a move sent with another Origin changes nothing", async ({ browser }) => {
  const moving = sql(`insert into public.deals (org_id, company_id, stage_id, owner_id, created_by, title, value, stage_entered_at, version)
                      select '${org}', '${lead}', s.id, '${admin}', '${admin}', 'Cross site ${run}', 100, now(), 0
                        from public.pipeline_stages s where s.org_id = '${org}' and s.key = 'lead' returning id`);
  const context = await browser.newContext({ storageState: adminState, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto("/pipeline");
  await expect(page.getByRole("region", { name: "Pipeline board" })).toBeVisible();
  await appReady(page);
  // The browser's own move is captured and stopped, then replayed exactly as a page on another site would send it with
  // this person's cookies, except for the Origin (see day4-security.spec.ts for why the request client is used).
  let captured: { headers: Record<string, string>; body: string } | null = null;
  await page.route("**/pipeline**", async (route) => {
    const request = route.request();
    if (request.method() === "POST" && request.headers()["next-action"] && !captured) {
      captured = { headers: request.headers(), body: request.postData() ?? "" };
      await route.abort();
    } else {
      await route.continue();
    }
  });
  await page.locator(`[data-deal-main="${moving}"]`).focus();
  await page.keyboard.press("Shift+ArrowRight");
  // error_copy_has_no_sql: the failed move says so in words and the card goes back.
  const toast = page.getByRole("status").filter({ hasText: /\S/ }).last();
  await expect(toast).toContainText("Couldn’t move the deal");
  await expect(toast).not.toContainText(noSql);
  await expect(page.locator('[data-column="lead"]').locator(`[data-deal-card="${moving}"]`)).toBeVisible();
  expect(captured).not.toBeNull();
  const { headers, body } = captured as unknown as { headers: Record<string, string>; body: string };
  const replay = await context.request.post(new URL(page.url()).pathname, {
    headers: { ...headers, origin: "https://evil.example" },
    data: body,
    maxRedirects: 0,
  });
  expect(replay.status()).toBe(500);
  expect(sql(`select s.key || ':' || d.version from public.deals d join public.pipeline_stages s on s.id = d.stage_id where d.id = '${moving}'`)).toBe(
    "lead:0",
  );
  // The same request with the page's own Origin runs (the replay itself is sound).
  expect(headers.origin).toBe(new URL(page.url()).origin);
  const same = await context.request.post(new URL(page.url()).pathname, { headers, data: body, maxRedirects: 0 });
  expect(same.status()).toBe(200);
  await expect.poll(() => sql(`select s.key from public.deals d join public.pipeline_stages s on s.id = d.stage_id where d.id = '${moving}'`)).toBe(
    "qualified",
  );
  await context.close();
});

test("error_copy_has_no_sql: the deal and pipeline APIs answer codes only", async ({ browser }) => {
  const context = await browser.newContext({ storageState: adminState });
  const answers = [
    await context.request.get(`/api/deals/not-a-uuid`),
    await context.request.get(`/api/pipeline/board?scope=everyone`),
    await context.request.get(`/api/pipeline/stage?stage=lead&extra=1`),
    await context.request.get(`/api/leads/not-a-uuid/deals`),
    await context.request.get(`/api/pipeline/summary?scope=team&owner=x`),
  ];
  expect(answers.map((a) => a.status())).toEqual([400, 400, 400, 400, 400]);
  for (const a of answers) {
    expect(Object.keys(await a.json())).toEqual(["error"]);
    expect(a.headers()["cache-control"]).toContain("no-store");
    expect(await a.text()).not.toMatch(noSql);
  }
  await context.close();
});

test("no_console_errors_no_csp_violations on the pipeline, the deal sheet and the lead's Deals tab", async ({ browser }) => {
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
  await page.goto(`/pipeline?deal=${deal}`);
  await expect(page.getByRole("dialog")).toContainText(`Sécurité Deals ${run}`);
  await appReady(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // A drag writes style attributes only (allowed by style-src): pick up with Space, move, cancel.
  await page.locator(`[data-deal-main="${deal}"]`).focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  await page.goto(`/leads/${lead}?tab=deals`);
  await expect(page.getByRole("tabpanel", { name: "Deals" })).toContainText(`Admin deal ${run}`);
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
  expect(errors).toEqual([]);
  await context.close();
});
