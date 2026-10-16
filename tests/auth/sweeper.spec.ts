import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createUser, nextWindow, setRole, sql, totp } from "./helpers";

// Day 7c: the orphan sweeper end to end on CI's real storage-api (E2E_STORAGE=1; skipped locally, where there is none;
// plan section 3 on day7-local). With the local stack's demo service key only (SUPABASE_LOCAL_SERVICE_ROLE_KEY; never a
// project key). Steps:
//   1. a ready file, uploaded the normal way (it must survive the sweep and still open);
//   2. a stray object made the spike S5 way: a signed upload link made, the upload cancelled and its row finished, then
//      bytes sent to the link (if storage-api refuses that PUT, the stray is uploaded with the service key instead and
//      the annotation says so);
//   3. the stray aged 2 days in SQL; the script run dry: it lists 1, deletes 0, the object stays;
//   4. the script run with apply: it removes the object through the Storage API; the team's stored bytes drop by its
//      size; the ready file still opens; two audit rows, counts only.
test.describe.configure({ mode: "serial" });
test.skip(!process.env.E2E_STORAGE, "needs storage-api: CI auth-journey only");

const password = "Sweeper-Pass-42!";
const email = `sweeper-${Date.now()}@example.test`;
const ROOT = path.join(__dirname, "..", "..");
let token = "";

function env(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}
const url = () => env("SUPABASE_LOCAL_URL");
const anonKey = () => env("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const headers = (extra: Record<string, string> = {}) => ({ apikey: anonKey(), Authorization: `Bearer ${token}`, ...extra });
const rpc = (fn: string, args: Record<string, unknown>) =>
  fetch(`${url()}/rest/v1/rpc/${fn}`, { method: "POST", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify(args) });

function sweep(mode: "dry" | "apply") {
  // The script's own entry point, as topstock-ops runs it; the local stack's address is allowed by SWEEP_ALLOW_LOCAL.
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, "scripts/ops/sweep-lead-files.mjs")], {
      encoding: "utf8",
      // Only what the script reads (no GITHUB_STEP_SUMMARY: the summary goes to stdout, where the test reads it).
      env: {
        PATH: process.env.PATH ?? "",
        SUPABASE_URL: url(),
        SWEEP_ALLOW_LOCAL: "1",
        SWEEPER_KEY: env("SUPABASE_LOCAL_SERVICE_ROLE_KEY"),
        SWEEP_MODE: mode,
      } as unknown as NodeJS.ProcessEnv,
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { code: err.status ?? -1, out: err.stdout ?? "" };
  }
}

async function upload(lead: string, name: string, body: Buffer) {
  const begun = (await (await rpc("begin_file_upload", { p_company: lead, p_name: name, p_mime: "application/pdf", p_size: body.length })).json()) as {
    id: string;
    path: string;
  };
  const sign = await fetch(`${url()}/storage/v1/object/upload/sign/lead-files/${begun.path}`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: "{}",
  });
  const signed = (await sign.json()) as { url?: string };
  expect(signed.url, "signed upload link").toBeTruthy();
  return { begun, signedUrl: `${url()}/storage/v1${signed.url}` };
}
const put = (signedUrl: string, body: Buffer) =>
  fetch(signedUrl, { method: "PUT", headers: { "content-type": "application/pdf", "x-upsert": "false" }, body: new Uint8Array(body) });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const secret = await createUser(email, password, true);
  setRole(email, "admin");
  const h = (t?: string) => ({ apikey: anonKey(), Authorization: `Bearer ${t ?? anonKey()}`, "Content-Type": "application/json" });
  const pw = await (await fetch(`${url()}/auth/v1/token?grant_type=password`, { method: "POST", headers: h(), body: JSON.stringify({ email, password }) })).json();
  const user = await (await fetch(`${url()}/auth/v1/user`, { headers: h(pw.access_token) })).json();
  const factor = (user.factors as { id: string; status: string }[]).find((f) => f.status === "verified")!;
  const challenge = await (await fetch(`${url()}/auth/v1/factors/${factor.id}/challenge`, { method: "POST", headers: h(pw.access_token), body: "{}" })).json();
  await nextWindow();
  const verified = await (
    await fetch(`${url()}/auth/v1/factors/${factor.id}/verify`, { method: "POST", headers: h(pw.access_token), body: JSON.stringify({ challenge_id: challenge.id, code: totp(secret) }) })
  ).json();
  token = verified.access_token;
  expect(token).toBeTruthy();
});

test("a stray object is listed by a dry run, then removed by apply; a ready file is untouched", async () => {
  const lead = sql(`insert into public.companies (org_id, name) select p.org_id, 'Sweeper lead ${Date.now()}' from public.profiles p
                    join auth.users u on u.id = p.id where u.email = '${email}' returning id`);
  const pdf = (n: number) => Buffer.from(`%PDF-1.7\n% sweeper ${n} ${"x".repeat(n)}\n%%EOF\n`);

  // 1. A ready file, the normal way.
  const keep = await upload(lead, "keep.pdf", pdf(10));
  expect((await put(keep.signedUrl, pdf(10))).ok).toBe(true);
  expect((await rpc("finish_file_upload", { p_id: keep.begun.id })).status).toBe(200);

  // 2. A stray, the spike S5 way: link made, upload cancelled and its row finished, then bytes sent to the link.
  const strayBody = pdf(500);
  const stray = await upload(lead, "stray.pdf", strayBody);
  expect((await rpc("abort_file_upload", { p_id: stray.begun.id })).status).toBe(200);
  expect([200, 204]).toContain((await rpc("finish_file_delete", { p_id: stray.begun.id })).status); // void: 204 or 200
  const late = await put(stray.signedUrl, strayBody);
  let how = "S5: bytes sent to a signed link after Cancel were stored";
  if (!late.ok) {
    how = `S5 PUT refused (HTTP ${late.status}); stray uploaded with the service key instead`;
    const key = env("SUPABASE_LOCAL_SERVICE_ROLE_KEY");
    const res = await fetch(`${url()}/storage/v1/object/lead-files/${stray.begun.path}`, {
      method: "POST",
      headers: { apikey: key, ...(key.startsWith("sb_") ? {} : { Authorization: `Bearer ${key}` }), "content-type": "application/pdf" },
      body: new Uint8Array(strayBody),
    });
    expect(res.ok, "service-key upload of the stray").toBe(true);
  }
  test.info().annotations.push({ type: "stray object", description: how });
  const strayPath = stray.begun.path;
  const org = strayPath.split("/")[0];
  const objects = () => Number(sql(`select count(*) from storage.objects where bucket_id = 'lead-files' and name = '${strayPath}'`));
  expect(objects()).toBe(1);
  expect(Number(sql(`select count(*) from public.files where storage_path = '${strayPath}'`))).toBe(0);
  const strayBytes = Number(sql(`select (metadata ->> 'size')::bigint from storage.objects where bucket_id = 'lead-files' and name = '${strayPath}'`));

  // Young: not listed yet (24-hour grace period).
  const young = sweep("dry");
  expect(young.code, young.out).toBe(0);
  expect(young.out).toContain("found 0 objects");

  // 3. Aged 2 days; a dry run lists it and deletes nothing.
  sql(`update storage.objects set created_at = now() - interval '2 days' where bucket_id = 'lead-files' and name = '${strayPath}'`);
  const bytesBefore = Number(sql(`select private.org_storage_bytes('${org}')`));
  const dry = sweep("dry");
  expect(dry.code, dry.out).toBe(0);
  expect(dry.out).toContain("found 1 objects");
  expect(dry.out).toContain(`org ${org}: 1 objects`);
  expect(dry.out).not.toContain(strayPath.split("/")[2]);
  expect(objects()).toBe(1);

  // 4. Apply: removed through the Storage API; the team's stored bytes drop by its size; the ready file still opens.
  const applied = sweep("apply");
  expect(applied.code, applied.out).toBe(0);
  expect(applied.out).toContain("removed 1 of 1 objects");
  expect(objects()).toBe(0);
  expect(Number(sql(`select private.org_storage_bytes('${org}')`))).toBe(bytesBefore - strayBytes);
  const opened = await rpc("open_file", { p_id: keep.begun.id });
  expect(opened.status).toBe(200);
  const rows = sql(`select diff_json::text from public.audit_log where action = 'file_sweep' order by id desc limit 2`).split("\n");
  expect(rows.map((r) => JSON.parse(r))).toEqual([
    { found: 1, removed: 1, bytes: strayBytes, dry_run: false },
    { found: 1, removed: 0, bytes: strayBytes, dry_run: true },
  ]);
});
