import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createUser, nextWindow, setRole, sql, totp } from "./helpers";

// Lead import at the REST API itself (design section 4, rows 3 and 6; section 6B). No browser: plain HTTP requests
// with each person's own access token, as anyone holding a stolen token or the public key could send them.
// - staging_not_exposed: staged lead rows (private.lead_import_staging) are not served by the REST API, not even to
//   the admin who staged them with a fresh code, by default or when the private schema is asked for by name. Only
//   supabase/config.toml (api.schemas = ["public"]) keeps them off the API; this catches a change to that, or the table
//   moving into public.
// - rep_direct_rpc_403: a rep's own token cannot start an import or read the import history.
// - the import functions refuse the public (publishable) key alone.
// CI (job "auth-journey", Chromium) runs real PostgREST behind the local stack's gateway. Locally, the stand-in in
// scripts/local-auth/gateway.mjs answers some of these requests differently; the checks that hold only on real
// PostgREST are marked and run only there.
test.describe.configure({ mode: "serial" });

const password = "Security-Pass-42!";
const run = Date.now();
const adminEmail = `import-sec-admin-${run}@example.test`;
const repEmail = `import-sec-rep-${run}@example.test`;
const fileSha = createHash("sha256").update(`import-security-${run}`).digest("hex");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let adminToken = "";
let repToken = "";
let realPostgrest = false;

// The same rule as helpers.ts: these requests carry the local stack's keys, so refuse anything that is not this machine.
function localEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see playwright.auth.config.ts)`);
  if (name.endsWith("_URL") && !["127.0.0.1", "localhost"].includes(new URL(v).hostname)) {
    throw new Error(`${name} must point at a local stack (127.0.0.1 or localhost)`);
  }
  return v;
}

type Init = { method?: string; token?: string; body?: unknown; headers?: Record<string, string> };

// One request to the local stack with the public key. Legacy JWT-style keys also go in Authorization; a signed-in
// person's own access token replaces it there.
function call(path: string, init: Init = {}) {
  const key = localEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const bearer = init.token ?? (key.startsWith("eyJ") ? key : undefined);
  return fetch(`${localEnv("SUPABASE_LOCAL_URL")}${path}`, {
    method: init.method ?? "GET",
    headers: {
      apikey: key,
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

// The status and the parsed body (null when the body is empty or not JSON).
type Answer = { status: number; body: unknown };
async function rest(path: string, init: Init = {}): Promise<Answer> {
  const res = await call(`/rest/v1${path}`, init);
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
  const res = await call(`/auth/v1${path}`, { method: "POST", ...init });
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return res.json();
}

// Password, then the authenticator code, through the Auth API: an aal2 access token with a fresh code, as after a real
// sign-in.
async function aal2Token(email: string, secret: string) {
  const { access_token: token } = await auth("/token?grant_type=password", { body: { email, password } });
  const user = (await auth("/user", { method: "GET", token })) as { factors?: { id: string; factor_type: string; status: string }[] };
  const factor = user.factors?.find((f) => f.factor_type === "totp" && f.status === "verified");
  if (!factor) throw new Error(`no verified authenticator for ${email}`);
  const challenge = await auth(`/factors/${factor.id}/challenge`, { token, body: {} });
  const verified = await auth(`/factors/${factor.id}/verify`, { token, body: { challenge_id: challenge.id, code: totp(secret) } });
  return verified.access_token as string;
}

function claims(token: string) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { aal?: string };
}

// Never a success, never a list of rows.
function expectNoRows(answer: Answer, what: string) {
  expect(answer.status, what).toBeGreaterThanOrEqual(400);
  expect(Array.isArray(answer.body), what).toBe(false);
}

const profileOf = (email: string) => `(select id from auth.users where email = '${email}')`;
const newImport = { p_filename: "security-check.csv", p_file_sha256: fileSha, p_row_count: 1, p_last_row_no: 2, p_timezone: "Europe/Paris" };

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const adminSecret = await createUser(adminEmail, password, true);
  const repSecret = await createUser(repEmail, password, true);
  setRole(adminEmail, "admin");
  setRole(repEmail, "rep");
  // Setting up each authenticator used this 30-second window's code: sign in with the next one.
  await nextWindow();
  adminToken = await aal2Token(adminEmail, adminSecret);
  repToken = await aal2Token(repEmail, repSecret);
  // The stand-in answers code "LOCAL" to any request it does not implement, such as a `limit`; real PostgREST serves
  // the list. CI must be on real PostgREST, so the checks marked "real PostgREST" can never be skipped there.
  const probe = await rest("/import_batches?select=id&limit=1", { token: adminToken });
  realPostgrest = !(probe.status === 400 && (probe.body as { code?: string } | null)?.code === "LOCAL");
  if (process.env.CI) expect(realPostgrest, "CI runs real PostgREST").toBe(true);
});

test.afterAll(() => {
  // Removes this file's own import, with any staged row a failed check left behind (staged rows go with their batch).
  sql(`delete from public.import_batches where uploaded_by in (${profileOf(adminEmail)}, ${profileOf(repEmail)})`);
});

test("staged lead rows are not served by the REST API, even to the admin who staged them", async () => {
  // A fresh-code admin: the import functions accept this token and one row is staged, so a refusal below means the API
  // does not serve the table, not that this person lacks the right to read it.
  expect(claims(adminToken).aal).toBe("aal2");
  const created = await rest("/rpc/create_lead_import", { method: "POST", token: adminToken, body: newImport });
  expect(created.status).toBe(200);
  const batch = String(created.body);
  expect(batch).toMatch(uuid);
  const row = { row_no: 2, name: "Atelier Verdane", email: "contact1@example.com", city: "Lyon", country: "FR", problems: [], fixes: [] };
  const staged = await rest("/rpc/stage_lead_import_rows", { method: "POST", token: adminToken, body: { p_batch: batch, p_rows: [row] } });
  expect(staged).toEqual({ status: 200, body: 1 });
  expect(sql(`select count(*) from private.lead_import_staging where batch_id = '${batch}'`)).toBe("1");

  const read = `/lead_import_staging?select=batch_id,row_no,name,email&batch_id=eq.${batch}`;
  // As a public table it does not exist: 404 on both servers (real PostgREST: PGRST205; the stand-in: 42P01).
  const plain = await rest(read, { token: adminToken });
  expectNoRows(plain, "GET lead_import_staging");
  expect(plain.status).toBe(404);
  // The private schema asked for by name. Real PostgREST refuses the schema itself: 406, PGRST106 ("The schema must be
  // one of the following: public"). The stand-in ignores the header and answers 404 as above.
  const viaPrivate = await rest(read, { token: adminToken, headers: { "Accept-Profile": "private" } });
  expectNoRows(viaPrivate, "GET lead_import_staging, Accept-Profile: private");
  if (realPostgrest) expect(viaPrivate).toMatchObject({ status: 406, body: { code: "PGRST106" } });
  else expect(viaPrivate.status).toBe(404);

  // Rewriting or deleting staged rows through the private schema is refused too (real PostgREST: 406 PGRST106; the
  // stand-in: 404 for the update, 400 "LOCAL" for the delete it does not implement), and the row stays as it was.
  const target = `/lead_import_staging?batch_id=eq.${batch}`;
  const rewrite = await rest(target, { method: "PATCH", token: adminToken, headers: { "Content-Profile": "private" }, body: { outcome: "ready" } });
  const removal = await rest(target, { method: "DELETE", token: adminToken, headers: { "Content-Profile": "private" } });
  expectNoRows(rewrite, "PATCH lead_import_staging, Content-Profile: private");
  expectNoRows(removal, "DELETE lead_import_staging, Content-Profile: private");
  if (realPostgrest) {
    expect(rewrite).toMatchObject({ status: 406, body: { code: "PGRST106" } });
    expect(removal).toMatchObject({ status: 406, body: { code: "PGRST106" } });
  }
  expect(sql(`select string_agg(outcome, ',') from private.lead_import_staging where batch_id = '${batch}'`)).toBe("pending");

  // Discarding through the import function deletes the staged row.
  const discarded = await rest("/rpc/discard_lead_import", { method: "POST", token: adminToken, body: { p_batch: batch } });
  expect(discarded.status).toBeLessThan(300);
  expect(sql(`select count(*) from private.lead_import_staging where batch_id = '${batch}'`)).toBe("0");
});

test("a rep's own token cannot start an import or read the import history (403, 42501)", async () => {
  // Signed in with the authenticator too: the refusal is about the role, not a missing code.
  expect(claims(repToken).aal).toBe("aal2");
  const started = await rest("/rpc/create_lead_import", { method: "POST", token: repToken, body: newImport });
  expect(started).toMatchObject({ status: 403, body: { code: "42501" } });
  expect(sql(`select count(*) from public.import_batches where uploaded_by = ${profileOf(repEmail)}`)).toBe("0");
  const history = await rest("/rpc/list_lead_imports", { method: "POST", token: repToken, body: {} });
  expect(history).toMatchObject({ status: 403, body: { code: "42501" } });
  expectNoRows(history, "list_lead_imports as a rep");
  // Reading the batches table directly answers an empty list (row level security), although the admin's import above
  // is still there as history.
  expect(Number(sql("select count(*) from public.import_batches"))).toBeGreaterThan(0);
  expect(await rest("/import_batches?select=id", { token: repToken })).toEqual({ status: 200, body: [] });
});

test("the import functions refuse the public key alone (no one signed in)", async () => {
  const batch = crypto.randomUUID();
  const calls: [string, Record<string, unknown>][] = [
    ["create_lead_import", newImport],
    ["stage_lead_import_rows", { p_batch: batch, p_rows: [] }],
    ["validate_lead_import", { p_batch: batch }],
    ["list_lead_import_issues", { p_batch: batch }],
    ["commit_lead_import", { p_batch: batch }],
    ["preview_lead_import_rollback", { p_batch: batch }],
    ["rollback_lead_import", { p_batch: batch }],
    ["discard_lead_import", { p_batch: batch }],
    ["list_lead_imports", {}],
  ];
  for (const [name, body] of calls) {
    const answer = await rest(`/rpc/${name}`, { method: "POST", body });
    // The database refuses to start the function at all: execute is revoked from anon (42501, "permission denied for
    // function"), so this is not the function's own "admins only" check (same code, hint "admin"). PostgREST answers
    // 42501 with 401 when no one is signed in and 403 otherwise, depending on how it reads the public key; the stand-in
    // answers 401.
    expectNoRows(answer, name);
    expect.soft([401, 403], `${name} status`).toContain(answer.status);
    expect.soft(answer.body, `${name} body`).toMatchObject({ code: "42501", message: `permission denied for function ${name}` });
  }
  expect(sql(`select count(*) from public.import_batches where file_sha256 = '${fileSha}' and status <> 'discarded'`)).toBe("0");
});
