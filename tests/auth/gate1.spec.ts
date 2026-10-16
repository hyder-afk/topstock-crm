import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, test, type BrowserContext } from "@playwright/test";
import { appReady, createUser, fullSession, nextWindow, setRole, sql, totp } from "./helpers";

// Gate 1 two-user attack test (Master Plan section 8, "Two-user attack test", steps 1 to 8), Day 7d. One run with its own
// three people (Rep A, Rep B, Admin) and its own fake data. Each step here fills what the existing suites do not already
// prove; the full step-to-test map (this file, the SQL attack files, the other specs) is
// docs/evidence/day7d/two-user-map.md. Every write attempt is followed by a read of the database as its superuser, so a
// refusal that still changed something fails. CI (auth-journey) runs real PostgREST; locally
// scripts/local-auth/gateway.mjs stands in (rpc calls, table GET and PATCH only), so the PostgREST-only checks are marked.
test.describe.configure({ mode: "serial" });

const password = "Gate1-Attack-Pass-42!";
const run = Date.now();
const repAEmail = `g1-rep-a-${run}@example.test`;
const repBEmail = `g1-rep-b-${run}@example.test`;
const adminEmail = `g1-admin-${run}@example.test`;
const ZERO = "00000000-0000-4000-8000-000000000000";
const XSS = `<img src=x onerror="window.__gate1xss=1">`;
const XSS2 = `<script>window.__gate1xss=2</script>`;
const XSS3 = `"><svg onload="window.__gate1xss=3">`;
// Database or stack words that must never reach a person in an answer.
const noSql = /select |insert |update |delete |violat|constraint|syntax|postgres|relation|column|stack|at \/|\.ts:|42501|22023|P0002|PGRST/i;

let repA = "";
let repB = "";
let admin = "";
let org = "";
let tokA = "";
let tokB = "";
let tokAdmin = "";
let tokAal1 = "";
let realPostgrest = false;
let aLead = "";
let bLead = "";
let bContact = "";
let bDeal = "";
let bTask = "";
let bNote = "";
let product = "";
let stateA: Awaited<ReturnType<BrowserContext["storageState"]>>;
let stateAdmin: Awaited<ReturnType<BrowserContext["storageState"]>>;

function localEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see playwright.auth.config.ts)`);
  if (name.endsWith("_URL") && !["127.0.0.1", "localhost"].includes(new URL(v).hostname)) {
    throw new Error(`${name} must point at a local stack (127.0.0.1 or localhost)`);
  }
  return v;
}

type Init = { method?: string; token?: string | null; body?: unknown; headers?: Record<string, string> };
// A request to the Supabase API as a browser would send it: the public key always, a person's token when given.
async function call(path: string, init: Init = {}) {
  const key = localEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const bearer = init.token === undefined || init.token === null ? (key.startsWith("eyJ") ? key : undefined) : init.token;
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
    body = text;
  }
  return { status: res.status, body, text };
}
const rpc = (fn: string, token: string | null, body: Record<string, unknown>) => call(`/rest/v1/rpc/${fn}`, { method: "POST", token, body });

async function auth(path: string, init: Init) {
  const r = await call(`/auth/v1${path}`, { method: "POST", ...init });
  if (r.status >= 400) throw new Error(`${path} failed: ${r.status}`);
  return r.body as Record<string, unknown>;
}
async function passwordToken(email: string) {
  return ((await auth("/token?grant_type=password", { body: { email, password } })) as { access_token: string }).access_token;
}
async function aal2Token(email: string, secret: string) {
  const token = await passwordToken(email);
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
// Runs SQL as a signed-in person with a fresh code, in one transaction (the RPCs' own checks all apply).
function asUser(id: string, body: string) {
  const claims = `json_build_object('sub', '${id}', 'role', 'authenticated', 'aal', 'aal2', 'amr',
                   json_build_array(json_build_object('method', 'totp', 'timestamp', extract(epoch from now())::bigint)))::text`;
  return sql(`begin; select set_config('request.jwt.claims', ${claims}, true); set local role authenticated; ${body}; commit;`);
}
// Everything Rep B owns in this run, as one string: any change by an attack shows up as a difference.
const bSnapshot = () =>
  sql(`select concat_ws('|',
         (select concat_ws(',', name, owner_id, lead_status, phone, city, org_id, timezone, next_action_at) from public.companies where id = '${bLead}'),
         (select concat_ws(',', first_name, phone) from public.contacts where id = '${bContact}'),
         (select concat_ws(',', title, owner_id, stage_id, status, value, version) from public.deals where id = '${bDeal}'),
         (select concat_ws(',', title, assignee_id, done_at, cancelled_at) from public.tasks where id = '${bTask}'),
         (select concat_ws(',', body, deal_id) from public.activities where id = '${bNote}'),
         (select string_agg(role::text, ',' order by id) from public.profiles where id in ('${repA}', '${repB}', '${admin}')))`);
const stockRow = () =>
  sql(`select string_agg(l.on_hand || '/' || l.reserved, ',' order by x.kind) from public.stock_levels l
         join public.locations x on x.id = l.location_id where l.product_id = '${product}' and x.kind = 'warehouse'`);
const refused = (status: number) => expect(status, "refused").toBeGreaterThanOrEqual(400);
// The call reached the function (a missing argument would answer "no such function" and prove nothing).
const reached = (what: string, r: { body: unknown }) =>
  expect(["42883", "PGRST202", "LOCAL"], `${what} reached the function or table`).not.toContain((r.body as { code?: string } | null)?.code ?? "");
let today = "";
// The local stand-in answers 400 "LOCAL" to a request shape it does not serve: such an answer proves nothing, so it fails.
const notLocal = (what: string, r: { body: unknown }) =>
  expect((r.body as { code?: string } | null)?.code, `${what}: the local gateway did not serve this request`).not.toBe("LOCAL");

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  // Step 1: Rep A, Rep B and an Admin, fake addresses only (@example.test), each with an authenticator.
  const secretA = await createUser(repAEmail, password, true);
  const secretB = await createUser(repBEmail, password, true);
  const secretAdmin = await createUser(adminEmail, password, true);
  setRole(repAEmail, "rep");
  setRole(repBEmail, "rep");
  setRole(adminEmail, "admin");
  repA = userId(repAEmail);
  repB = userId(repBEmail);
  admin = userId(adminEmail);
  org = sql(`select org_id from public.profiles where id = '${admin}'`);
  today = sql(`select (now() at time zone 'Europe/Paris')::date`);
  aLead = sql(`insert into public.companies (org_id, name, owner_id, lead_status, phone, city, country)
               values ('${org}', 'Gate1 A ${run}', '${repA}', 'warm', '06 11 11 11 11', 'Lyon', 'FR') returning id`);
  bLead = sql(`insert into public.companies (org_id, name, owner_id, lead_status, phone, city, country)
               values ('${org}', 'Gate1 B ${run}', '${repB}', 'warm', '06 22 22 22 22', 'Lille', 'FR') returning id`);
  bContact = sql(`insert into public.contacts (org_id, company_id, first_name, phone)
                  values ('${org}', '${bLead}', 'Bérénice', '+33 6 22 22 22 23') returning id`);
  bDeal = sql(`insert into public.deals (org_id, company_id, stage_id, owner_id, created_by, title, value, stage_entered_at, version)
               select '${org}', '${bLead}', s.id, '${repB}', '${repB}', 'B deal ${run}', 4200, now(), 0
                 from public.pipeline_stages s where s.org_id = '${org}' and s.key = 'qualified' returning id`);
  bTask = sql(`insert into public.tasks (org_id, company_id, assignee_id, created_by, title, kind, due_date)
               values ('${org}', '${bLead}', '${repB}', '${repB}', 'B task ${run}', 'call', (now() at time zone 'Europe/Paris')::date)
               returning id`);
  bNote = sql(`insert into public.activities (org_id, company_id, user_id, type, body)
               values ('${org}', '${bLead}', '${repB}', 'note', 'B note ${run}') returning id`);
  product = asUser(
    admin,
    `select public.create_product(p_name => 'Gate1 carton ${run}', p_pieces_per_carton => 10, p_price_min => 1, p_price_max => 2,
       p_opening_qty => 5, p_opening_location => 'warehouse')`,
  ).split("\n").find((l) => /^[0-9a-f-]{36}$/.test(l))!;
  await nextWindow();
  tokA = await aal2Token(repAEmail, secretA);
  tokB = await aal2Token(repBEmail, secretB);
  tokAdmin = await aal2Token(adminEmail, secretAdmin);
  tokAal1 = await passwordToken(repAEmail);
  const probe = await call("/rest/v1/companies?select=id&limit=1", { token: tokAdmin });
  realPostgrest = !(probe.status === 400 && (probe.body as { code?: string } | null)?.code === "LOCAL");
  if (process.env.CI) expect(realPostgrest, "CI runs real PostgREST").toBe(true);
  stateA = await fullSession(browser, repAEmail, password, secretA);
  stateAdmin = await fullSession(browser, adminEmail, password, secretAdmin);
});

test("step1_three_people_fake_data: Rep A, Rep B and Admin exist with their roles; every address is a test address", async () => {
  expect(sql(`select string_agg(p.role::text, ',' order by u.email) from public.profiles p join auth.users u on u.id = p.id
               where p.id in ('${repA}', '${repB}', '${admin}')`)).toBe("admin,rep,rep");
  expect(sql(`select count(*) from auth.users where id in ('${repA}', '${repB}', '${admin}') and email !~ '@example\\.test$'`)).toBe("0");
  // Rep B's records exist and belong to Rep B; Rep A's lead to Rep A.
  expect(sql(`select count(*) from public.companies where id = '${bLead}' and owner_id = '${repB}'`)).toBe("1");
  expect(sql(`select count(*) from public.deals where id = '${bDeal}' and owner_id = '${repB}'`)).toBe("1");
  expect(sql(`select count(*) from public.tasks where id = '${bTask}' and assignee_id = '${repB}'`)).toBe("1");
  // Rep B sees their own deal and task (so the refusals below are about the person, not broken fixtures).
  const own = await rpc("get_deal", tokB, { p_id: bDeal });
  expect(own.status).toBe(200);
  expect(JSON.stringify(own.body)).toContain(`B deal ${run}`);
});

test("step2_direct_api: Rep A's own token cannot read Rep B's deal or task, nor change or delete any of Rep B's records", async () => {
  const before = bSnapshot();
  // Read: deals and tasks are the owner's (leads, contacts and entries are readable by every teammate by design,
  // Haider "3 yes", 9 Oct; they stay read-only for them).
  const deal = await rpc("get_deal", tokA, { p_id: bDeal });
  const missing = await rpc("get_deal", tokA, { p_id: ZERO });
  expect(deal.status).toBe(missing.status);
  expect(deal.body).toEqual(missing.body);
  const dealRows = await call(`/rest/v1/deals?select=id,title&id=eq.${bDeal}`, { token: tokA });
  expect(dealRows.status).toBe(200);
  expect(dealRows.body).toEqual([]);
  const taskRows = await call(`/rest/v1/tasks?select=id,title&id=eq.${bTask}`, { token: tokA });
  expect(taskRows.status).toBe(200);
  expect(taskRows.body).toEqual([]);
  // Table writes through the REST API (PATCH; DELETE and POST only on real PostgREST).
  for (const [table, id, patch] of [
    ["companies", bLead, { name: "hacked" }],
    ["companies", bLead, { lead_status: "customer" }],
    ["contacts", bContact, { first_name: "hacked" }],
    ["deals", bDeal, { title: "hacked" }],
    ["tasks", bTask, { title: "hacked" }],
    ["activities", bNote, { body: "hacked" }],
  ] as const) {
    const r = await call(`/rest/v1/${table}?id=eq.${id}`, { method: "PATCH", token: tokA, body: patch });
    reached(`${table} PATCH`, r);
    expect(r.status === 204 || r.status === 200 || r.status >= 400, `${table} PATCH answered`).toBe(true);
    expect(bSnapshot(), `${table} PATCH changed nothing`).toBe(before);
    if (realPostgrest) {
      const d = await call(`/rest/v1/${table}?id=eq.${id}`, { method: "DELETE", token: tokA });
      expect(d.status === 204 || d.status >= 400, `${table} DELETE answered`).toBe(true);
      expect(bSnapshot(), `${table} DELETE changed nothing`).toBe(before);
    }
  }
  // Every RPC that writes one of these records, called by Rep A on Rep B's ids.
  for (const [fn, body] of [
    ["update_lead", { p_id: bLead, p_name: "hacked", p_owner: repB, p_status: "warm", p_phone: "06 22 22 22 22", p_email: null, p_city: "Lille", p_country: "FR" }],
    ["bulk_update_leads", { p_ids: [bLead], p_status: "customer" }],
    ["set_lead_next_action", { p_id: bLead, p_at: new Date(Date.now() + 86_400_000).toISOString() }],
    ["set_lead_timezone", { p_id: bLead, p_timezone: "Asia/Tokyo" }],
    ["update_contact", { p_id: bContact, p_first_name: "hacked", p_last_name: null, p_title: null, p_email: null, p_phone: "+33 6 22 22 22 23" }],
    ["update_deal", { p_id: bDeal, p_expected_version: 0, p_fields: ["title"], p_title: "hacked" }],
    ["move_deal", { p_id: bDeal, p_stage: "negotiations", p_expected_version: 0 }],
    ["delete_deal", { p_id: bDeal }],
    ["update_task", { p_id: bTask, p_title: "hacked", p_due_date: today, p_due_at: null, p_assignee: repB, p_contact: null }],
    ["set_task_done", { p_id: bTask, p_done: true }],
    ["set_task_cancelled", { p_id: bTask, p_cancelled: true }],
    ["delete_task", { p_id: bTask }],
    ["edit_activity", { p_id: bNote, p_body: "hacked" }],
    ["delete_activity", { p_id: bNote }],
    ["undo_activity", { p_id: bNote }],
  ] as const) {
    const r = await rpc(fn, tokA, body);
    reached(fn, r);
    expect(bSnapshot(), `${fn} changed nothing`).toBe(before);
    // Either an error, or an answer that says nothing happened; never Rep B's data in the answer.
    expect(r.text, `${fn} leaks nothing`).not.toContain(`B deal ${run}`);
    expect(r.text, `${fn} leaks nothing`).not.toContain(`B task ${run}`);
  }
  // The same calls work for the owner (the refusals above are about the person): Rep B edits the task title.
  const ok = await rpc("update_task", tokB, { p_id: bTask, p_title: `B task ${run}`, p_due_date: today, p_due_at: null, p_assignee: repB, p_contact: null });
  expect(ok.status, JSON.stringify(ok.body)).toBeLessThan(300);
});

test("step2_app_routes_and_urls: Rep A gets not found for Rep B's deal and sees no trace of Rep B's task through the app", async ({ browser }) => {
  const context = await browser.newContext({ storageState: stateA });
  const deal = await context.request.get(`/api/deals/${bDeal}`);
  const none = await context.request.get(`/api/deals/${ZERO}`);
  expect(deal.status()).toBe(404);
  expect(await deal.json()).toEqual(await none.json());
  const tasks = await context.request.get(`/api/leads/${bLead}/tasks`);
  expect(tasks.status()).toBe(200);
  expect(await tasks.text()).not.toContain(bTask);
  const lists = await context.request.get(`/api/tasks?scope=team`);
  expect([200, 400, 403]).toContain(lists.status());
  expect(await lists.text()).not.toContain(bTask);
  const dealsTab = await context.request.get(`/api/leads/${bLead}/deals`);
  expect(dealsTab.status()).toBe(200);
  expect(await dealsTab.text()).not.toContain(bDeal);
  // Direct URL: Rep B's lead opens read-only for a teammate (by design), and the page holds neither Rep B's deal nor task.
  const page = await context.newPage();
  await page.goto(`/leads/${bLead}`);
  await appReady(page);
  await expect(page.getByRole("heading", { name: `Gate1 B ${run}` })).toBeVisible();
  const html = await page.content();
  expect(html).not.toContain(`B deal ${run}`);
  expect(html).not.toContain(`B task ${run}`);
  await context.close();
});

test("step3_anon_key_every_table: the public key alone reads and writes nothing in any table, view or function", async () => {
  const tables = sql(`select string_agg(c.relname || ':' || (select a.attname from pg_attribute a where a.attrelid = c.oid and a.attnum = 1), ' ' order by c.relname)
                        from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v', 'p')
                         and c.relname not like 'local\\_gateway\\_%'`).split(" ");
  expect(tables.length).toBeGreaterThan(15);
  for (const t of tables) {
    const [name, col] = t.split(":");
    const r = await call(`/rest/v1/${name}?select=${col}`, { token: null });
    notLocal(name, r);
    // 401 or 403 (no privilege) or 404; never rows. An empty 200 would also be safe, but no table grants anon at all.
    expect(r.status, `${name}: ${r.text.slice(0, 120)}`).toBeGreaterThanOrEqual(400);
    expect(r.text, name).not.toContain(org);
    const p = await call(`/rest/v1/${name}?${col}=eq.${ZERO}`, { method: "PATCH", token: null, body: { [col]: null } });
    notLocal(`${name} PATCH`, p);
    expect(p.status, `${name} PATCH`).toBeGreaterThanOrEqual(400);
    if (realPostgrest) {
      const post = await call(`/rest/v1/${name}`, { method: "POST", token: null, body: {} });
      expect(post.status, `${name} POST`).toBeGreaterThanOrEqual(400);
      const del = await call(`/rest/v1/${name}?${col}=eq.${ZERO}`, { method: "DELETE", token: null });
      expect(del.status, `${name} DELETE`).toBeGreaterThanOrEqual(400);
    }
  }
  // Every function in public: only the two share functions answer anon (they check the link token themselves).
  // Each is called with all its input arguments (as null), so the call reaches the function and the answer is about the
  // privilege: an empty body would only get "no such function" (404) whatever the grants say.
  const fns = sql(`select string_agg(f, ' ' order by f) from (
                     select distinct on (p.proname) p.proname || ':' || case when p.proargnames is null then '' else coalesce((
                              select string_agg(a.n, ',' order by a.o)
                                from unnest(p.proargnames, coalesce(p.proargmodes, array_fill('i'::"char", array[cardinality(p.proargnames)])))
                                     with ordinality as a (n, m, o)
                               where a.m in ('i', 'b', 'v')), '') end as f
                       from pg_proc p
                      where p.pronamespace = 'public'::regnamespace and p.proname not like 'local\\_gateway\\_%'
                      order by p.proname, p.pronargs) x`).split(" ");
  expect(fns.length).toBeGreaterThan(80);
  for (const entry of fns) {
    const [fn, args] = entry.split(":");
    if (fn === "share_view" || fn === "share_request") continue;
    const body = Object.fromEntries((args ? args.split(",") : []).map((a) => [a, null]));
    const r = await rpc(fn, null, body);
    // 401 from PostgREST for anon without EXECUTE (42501); 403 if a gateway answers so. Never 2xx, never a 400 from inside.
    expect([401, 403], `${fn}: ${r.status} ${r.text.slice(0, 120)}`).toContain(r.status);
  }
  const share = await rpc("share_view", null, { p_token: "not-a-real-token", p_known_version: null });
  expect(share.text).not.toContain(org);
  // The private schema is not served at all (real PostgREST: schema not exposed).
  if (realPostgrest) {
    const priv = await call(`/rest/v1/stock_movements?select=id`, { token: null, headers: { "Accept-Profile": "private" } });
    expect(priv.status).toBeGreaterThanOrEqual(400);
  }
  // A password-only (aal1) session of a real person reads nothing either: the two-factor policy is on every table.
  for (const t of tables) {
    const [name, col] = t.split(":");
    const r = await call(`/rest/v1/${name}?select=${col}`, { token: tokAal1 });
    notLocal(`${name} as aal1`, r);
    if (r.status === 200) expect(r.body, `${name} as aal1`).toEqual([]);
    else expect(r.status, `${name} as aal1`).toBeGreaterThanOrEqual(400);
  }
});

test("step4_role_and_owner_tamper: Rep A cannot make themselves admin, take Rep B's lead, or hand their own lead to another org", async () => {
  const before = bSnapshot();
  const ownBefore = sql(`select concat_ws(',', owner_id, org_id) from public.companies where id = '${aLead}'`);
  for (const attempt of [
    () => call(`/rest/v1/profiles?id=eq.${repA}`, { method: "PATCH", token: tokA, body: { role: "admin" } }),
    () => call(`/rest/v1/profiles?id=eq.${repA}`, { method: "PATCH", token: tokA, body: { org_id: ZERO } }),
    () => rpc("set_user_role", tokA, { target_user: repA, new_role: "admin" }),
    () => rpc("set_user_role", tokA, { target_user: repB, new_role: "admin" }),
    () => call(`/rest/v1/companies?id=eq.${bLead}`, { method: "PATCH", token: tokA, body: { owner_id: repA } }),
    () => rpc("update_lead", tokA, { p_id: bLead, p_name: `Gate1 B ${run}`, p_owner: repA, p_status: "warm", p_phone: "06 22 22 22 22", p_email: null, p_city: "Lille", p_country: "FR" }),
    () => rpc("update_lead", tokA, { p_id: aLead, p_name: `Gate1 A ${run}`, p_owner: repB, p_status: "warm", p_phone: "06 11 11 11 11", p_email: null, p_city: "Lyon", p_country: "FR" }),
    () => rpc("update_task", tokA, { p_id: bTask, p_title: `B task ${run}`, p_due_date: today, p_due_at: null, p_assignee: repA, p_contact: null }),
    () => rpc("bulk_update_leads", tokA, { p_ids: [bLead], p_set_owner: true, p_owner: repA }),
    () => call(`/rest/v1/companies?id=eq.${aLead}`, { method: "PATCH", token: tokA, body: { org_id: ZERO } }),
    () => call(`/rest/v1/companies?id=eq.${aLead}`, { method: "PATCH", token: tokA, body: { owner_id: repB } }),
    () => call(`/rest/v1/deals?id=eq.${bDeal}`, { method: "PATCH", token: tokA, body: { owner_id: repA } }),
    () => rpc("update_deal", tokA, { p_id: bDeal, p_expected_version: 0, p_fields: ["owner_id"], p_owner: repA }),
    () => call(`/rest/v1/tasks?id=eq.${bTask}`, { method: "PATCH", token: tokA, body: { assignee_id: repA } }),
    // A rep may not hand work to someone else either (managers and admins choose owners).
    () => rpc("open_deal", tokA, { p_company: aLead, p_title: "for B", p_owner: repB }),
    () => rpc("create_task", tokA, { p_title: "for B", p_company: aLead, p_assignee: repB }),
  ]) {
    const r = await attempt();
    reached(String(attempt), r);
    expect(bSnapshot()).toBe(before);
    expect(sql(`select concat_ws(',', owner_id, org_id) from public.companies where id = '${aLead}'`)).toBe(ownBefore);
  }
  expect(sql(`select role from public.profiles where id = '${repA}'`)).toBe("rep");
  expect(sql(`select count(*) from public.deals where company_id = '${aLead}'`)).toBe("0");
  expect(sql(`select count(*) from public.tasks where company_id = '${aLead}' and assignee_id = '${repB}'`)).toBe("0");
  // The direct writes answer with a refusal, not a silent success (column grants and the guards).
  refused((await call(`/rest/v1/profiles?id=eq.${repA}`, { method: "PATCH", token: tokA, body: { role: "admin" } })).status);
  refused((await rpc("set_user_role", tokA, { target_user: repA, new_role: "admin" })).status);
});

// Every route handler under src/app/api, read from the disk so a new one is swept the day it lands.
function apiRoutes() {
  const root = join(process.cwd(), "src/app/api");
  const out: { path: string; methods: string[] }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "route.ts") {
        const text = readFileSync(full, "utf8");
        const methods = [...text.matchAll(/^export (?:async function|const) (GET|POST|PATCH|PUT|DELETE)\b/gm)].map((m) => m[1]);
        out.push({ path: "/api/" + relative(root, dir).split(sep).join("/"), methods });
      }
    }
  };
  walk(root);
  return out;
}

test("step5_bad_input_every_api: oversized, malformed and script-laden input gets a code, never database text or reflected markup", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const routes = apiRoutes();
  expect(routes.length).toBeGreaterThan(30);
  const context = await browser.newContext({ storageState: stateAdmin });
  const origin = new URL(baseURL!).origin;
  const ids = ["not-a-uuid", "'; drop table companies; --", "x".repeat(5000), `${ZERO}),id.eq.${ZERO}`];
  const queries = [`q=${encodeURIComponent(XSS)}`, `q=${"a".repeat(10_000)}`, `limit=-1&after_id=${encodeURIComponent("),id.gt.0")}`, `scope=${encodeURIComponent(XSS2)}`];
  const checkAnswer = async (what: string, res: import("@playwright/test").APIResponse) => {
    const text = await res.text();
    expect(res.status(), what).toBeLessThan(500);
    // Answers are JSON (a browser never renders them as a page); stored text may hold markup as data, which the screens
    // show as text (next test). An error answer never repeats what was sent.
    if (res.status() < 300 || res.status() >= 400) expect(res.headers()["content-type"] ?? "", what).toContain("application/json");
    if (res.status() >= 400) {
      expect(text, what).not.toMatch(noSql);
      expect(text, what).not.toContain("<img src=x");
      expect(text, what).not.toContain("<script>");
      const body = JSON.parse(text) as Record<string, unknown>;
      // The app's APIs answer {error[, hint][, ok]}; the public share routes {status} (Day 6e wire format).
      expect(Object.keys(body).sort().join(","), what).toMatch(/^(error|error,hint|error,ok|error,hint,ok|status)$/);
      expect(String(body.error ?? body.status), what).toMatch(/^[a-z_]+$/);
    }
  };
  for (const route of routes) {
    for (const method of route.methods) {
      const paths = route.path.includes("[id]") ? ids.map((id) => route.path.replace("[id]", encodeURIComponent(id))) : [route.path];
      if (method === "GET") {
        for (const p of paths) for (const q of route.path.includes("[id]") ? [""] : queries) {
          await checkAnswer(`GET ${p}?${q.slice(0, 40)}`, await context.request.get(q ? `${p}?${q}` : p, { maxRedirects: 0 }));
        }
      } else {
        for (const p of paths) {
          const send = (data: string, type = "application/json") =>
            context.request.fetch(p, { method, headers: { Origin: origin, "Content-Type": type }, data, maxRedirects: 0 });
          await checkAnswer(`${method} ${p} malformed`, await send("{not json"));
          await checkAnswer(`${method} ${p} oversized`, await send(JSON.stringify({ x: "a".repeat(2_000_000) })));
          await checkAnswer(`${method} ${p} wrong type`, await send("a=1", "application/x-www-form-urlencoded"));
          await checkAnswer(`${method} ${p} script and extra fields`, await send(JSON.stringify({ note: XSS, owner_id: ZERO, org_id: ZERO, role: "admin" })));
        }
      }
    }
  }
  await context.close();
});

test("step5_script_in_text_fields_renders_as_text: lead, contact, task and product names with markup never run", async ({ browser }) => {
  const lead = sql(`insert into public.companies (org_id, name, owner_id, lead_status, phone, city, country)
                    values ('${org}', $x$${XSS} ${run}$x$, '${repA}', 'warm', '06 33 33 33 33', $x$${XSS3}$x$, 'FR') returning id`);
  sql(`insert into public.contacts (org_id, company_id, first_name, last_name, title, phone)
       values ('${org}', '${lead}', $x$${XSS2}$x$, $x$${XSS}$x$, $x$${XSS3}$x$, '+33 6 33 33 33 34')`);
  sql(`insert into public.tasks (org_id, company_id, assignee_id, created_by, title, kind, due_date)
       values ('${org}', '${lead}', '${repA}', '${repA}', $x$${XSS2} task ${run}$x$, 'todo', (now() at time zone 'Europe/Paris')::date)`);
  const xssProduct = asUser(admin, `select public.create_product(p_name => $x$${XSS3} ${run}$x$, p_pieces_per_carton => 10, p_price_min => 1, p_price_max => 2)`)
    .split("\n").find((l) => /^[0-9a-f-]{36}$/.test(l))!;
  const context = await browser.newContext({ storageState: stateA });
  const page = await context.newPage();
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  for (const [url, shown] of [
    [`/leads/${lead}`, `${XSS} ${run}`],
    [`/leads?q=${encodeURIComponent(String(run))}`, `${XSS} ${run}`],
    [`/tasks`, `${XSS2} task ${run}`],
    [`/inventory/p/${xssProduct}`, `${XSS3} ${run}`],
  ] as const) {
    await page.goto(url);
    await appReady(page);
    await expect(page.getByText(shown, { exact: false }).first(), url).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __gate1xss?: number }).__gate1xss), url).toBeUndefined();
  }
  expect(dialogs).toEqual([]);
  await context.close();
});

test("item2_repository_files_not_served: signed in, /.env and the other repository files answer 404 without their contents", async ({ browser }) => {
  const context = await browser.newContext({ storageState: stateAdmin });
  for (const path of ["/.env", "/.env.local", "/.env.production", "/.env.example", "/.git/config", "/package.json", "/next.config.ts", "/supabase/config.toml", "/.mcp.json"]) {
    const res = await context.request.get(path, { maxRedirects: 0 });
    expect(res.status(), path).toBe(404);
    expect(await res.text(), path).not.toMatch(/SUPABASE_|ANON_KEY|SERVICE_ROLE|\[core\]|"dependencies"|project_ref/);
  }
  await context.close();
});

test("item45_admin_pages_by_direct_url: a rep gets the not-found page and a signed-out visitor the sign-in page on every admin screen", async ({ browser, playwright, baseURL }) => {
  // The page streams behind its loading skeleton, so the not-found answer shows in the page (the HTTP status is already
  // sent): what the rep sees is checked, as import.spec.ts and team.spec.ts do.
  const adminPages = ["/leads/import", "/inventory/import", "/inventory/settings", "/more/team"];
  const rep = await browser.newContext({ storageState: stateA });
  const admin = await browser.newContext({ storageState: stateAdmin });
  const repPage = await rep.newPage();
  const adminPage = await admin.newPage();
  const signedOut = await playwright.request.newContext({ baseURL });
  for (const path of adminPages) {
    await repPage.goto(path);
    await expect(repPage.locator("main h1"), `rep ${path}`).toHaveText("This page isn’t here");
    await adminPage.goto(path);
    await expect(adminPage.locator("main h1"), `admin ${path}`).toBeVisible();
    await expect(adminPage.locator("main h1"), `admin ${path}`).not.toHaveText("This page isn’t here");
    const out = await signedOut.get(path, { maxRedirects: 0 });
    expect(out.status(), `signed out ${path}`).toBe(307);
    expect(out.headers()["location"], `signed out ${path}`).toBe("/login");
  }
  await Promise.all([rep.close(), admin.close(), signedOut.dispose()]);
});

test("step8_stock_levels_direct_and_over_reservation_refused: direct writes fail for everyone; reserving past what is there is refused", async () => {
  const before = stockRow();
  expect(before).toBe("5/0");
  for (const token of [tokA, tokAdmin]) {
    const p = await call(`/rest/v1/stock_levels?product_id=eq.${product}`, { method: "PATCH", token, body: { on_hand: 9999, reserved: 0 } });
    reached("stock_levels PATCH", p);
    refused(p.status);
    expect(stockRow()).toBe(before);
    if (realPostgrest) {
      refused((await call(`/rest/v1/stock_levels`, { method: "POST", token, body: { product_id: product, on_hand: 9999 } })).status);
      refused((await call(`/rest/v1/stock_levels?product_id=eq.${product}`, { method: "DELETE", token })).status);
      expect(stockRow()).toBe(before);
    }
  }
  // Six cartons asked for, five there: refused with the engine's code; then five pass and a sixth single one is refused.
  const over = await rpc("post_stock_movement", tokAdmin, { p_product: product, p_kind: "reserve", p_qty: 6, p_location: "warehouse", p_company: aLead });
  refused(over.status);
  expect((over.body as { hint?: string }).hint).toBe("over_reservation");
  expect(stockRow()).toBe(before);
  const five = await rpc("post_stock_movement", tokAdmin, { p_product: product, p_kind: "reserve", p_qty: 5, p_location: "warehouse", p_company: aLead });
  expect(five.status, JSON.stringify(five.body)).toBeLessThan(300);
  for (const token of [tokAdmin, tokA]) {
    const sixth = await rpc("post_stock_movement", token, { p_product: product, p_kind: "reserve", p_qty: 1, p_location: "warehouse", p_company: aLead });
    refused(sixth.status);
  }
  expect(stockRow()).toBe("5/5");
  // Taking out more than is on hand is refused too (no negative stock).
  const out = await rpc("post_stock_movement", tokAdmin, { p_product: product, p_kind: "adjust_out", p_qty: 6, p_location: "warehouse", p_reason: "lost" });
  refused(out.status);
  expect(stockRow()).toBe("5/5");
});
