import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { createUser, nextWindow, setRole, sql, totp } from "./helpers";

// Day 4d storage spikes S2, S3 and S4 (design 2.4), measured on CI's real storage-api (E2E_STORAGE=1; skipped locally,
// where there is none). Each spike's fallback is already built, so these record what the real service does; they fail
// only where the built code would break. S1 is recorded by the db.yml step "Spike S1". Results go to
// test-results/spikes/day4d.json (CI artifact "storage-spikes") and the test annotations.
//  S2: does storage-api pass the whole JWT (aal, amr with the code's time) to storage.objects policies? Two probe
//      buckets, one readable with private.has_aal2(), one with private.has_recent_aal2(600). Fallback in place either
//      way: the step-up for deletes is in files_guard_update, and the bucket's policies use only has_aal2 (which must
//      work, or uploads fail: recorded as a failure).
//  S3: do signed links honour Range? Fallback in place either way (src/lib/files/stored-bytes.ts).
//  S4: storage.objects.metadata key names, and whether they are written before the insert policy runs (a probe bucket
//      whose insert policy needs metadata ? 'size'). The ready check runs at finish, after the upload, either way.
//  S5 (verifier 4d finding 8): is the insert policy (pending, the uploader's, under 15 minutes) checked again when bytes
//      reach a signed upload link, or only when the link is made? A link made for a pending upload, the upload then
//      cancelled, then bytes sent to the link. Recorded only: stray bytes this way are accepted residual risk 7 (they
//      still count against the team's space; files_attack.sql shows the quota reads real stored bytes).
test.describe.configure({ mode: "serial" });
test.skip(!process.env.E2E_STORAGE, "needs storage-api: CI auth-journey only");

const password = "Spikes-Pass-42!";
const email = `spikes-${Date.now()}@example.test`;
const results: Record<string, unknown> = { recorded_at: new Date().toISOString() };
let token = "";
let secret = "";

function env(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}
const url = () => env("SUPABASE_LOCAL_URL");
const key = () => env("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const headers = (extra: Record<string, string> = {}) => ({ apikey: key(), Authorization: `Bearer ${token}`, ...extra });

function record(name: string, value: unknown) {
  results[name] = value;
  test.info().annotations.push({ type: name, description: JSON.stringify(value) });
  mkdirSync("test-results/spikes", { recursive: true });
  writeFileSync("test-results/spikes/day4d.json", JSON.stringify(results, null, 2));
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  secret = await createUser(email, password, true);
  setRole(email, "admin");
  const h = (t?: string) => ({ apikey: key(), Authorization: `Bearer ${t ?? key()}`, "Content-Type": "application/json" });
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

test("S2: the claims storage-api gives the bucket policies (aal, amr)", async () => {
  sql(`insert into storage.buckets (id, name, public) values ('spike-aal', 'spike-aal', false), ('spike-amr', 'spike-amr', false) on conflict do nothing;
       insert into storage.objects (bucket_id, name, metadata) values ('spike-aal', 'probe.txt', '{}'), ('spike-amr', 'probe.txt', '{}') on conflict do nothing;
       create policy spike_aal on storage.objects for select to authenticated using (bucket_id = 'spike-aal' and (select private.has_aal2()));
       create policy spike_amr on storage.objects for select to authenticated using (bucket_id = 'spike-amr' and (select private.has_recent_aal2(600)));`);
  try {
    const list = async (bucket: string) => {
      const res = await fetch(`${url()}/storage/v1/object/list/${bucket}`, {
        method: "POST",
        headers: headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ prefix: "", limit: 10 }),
      });
      const body = (await res.json().catch(() => [])) as { name: string }[];
      return { status: res.status, sees_probe: Array.isArray(body) && body.some((o) => o.name === "probe.txt") };
    };
    const aal = await list("spike-aal");
    const amr = await list("spike-amr");
    record("S2", { has_aal2_in_storage_policies: aal, has_recent_aal2_in_storage_policies: amr });
    // The bucket's own policies need has_aal2: without it no upload could work.
    expect(aal.sees_probe, "storage-api must pass aal to the policies (uploads depend on it)").toBe(true);
  } finally {
    sql(`drop policy if exists spike_aal on storage.objects; drop policy if exists spike_amr on storage.objects;
         set storage.allow_delete_query = 'true'; delete from storage.objects where bucket_id in ('spike-aal', 'spike-amr'); delete from storage.buckets where id in ('spike-aal', 'spike-amr');`);
  }
});

test("S4: metadata keys, and whether they exist when the insert policy runs", async () => {
  const lead = sql(`insert into public.companies (org_id, name) select p.org_id, 'Spike lead ${Date.now()}' from public.profiles p
                    join auth.users u on u.id = p.id where u.email = '${email}' returning id`);
  const body = Buffer.from("%PDF-1.7\n%%EOF\n");
  const begun = await (
    await fetch(`${url()}/rest/v1/rpc/begin_file_upload`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ p_company: lead, p_name: "spike.pdf", p_mime: "application/pdf", p_size: body.length }),
    })
  ).json();
  const put = await fetch(`${url()}/storage/v1/object/lead-files/${begun.path}`, {
    method: "POST",
    headers: headers({ "content-type": "application/pdf", "x-upsert": "false", "cache-control": "max-age=0" }),
    body: new Uint8Array(body),
  });
  const keys = sql(`select coalesce(string_agg(k, ',' order by k), '') from storage.objects o, jsonb_object_keys(o.metadata) k where o.name = '${begun.path}'`);
  const values = sql(`select coalesce(private.object_size(metadata)::text, 'null') || ' ' || coalesce(private.object_mime(metadata), 'null') from storage.objects where name = '${begun.path}'`);
  const finished = await fetch(`${url()}/rest/v1/rpc/finish_file_upload`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ p_id: begun.id }),
  });
  // At insert time: a probe bucket whose insert policy needs the size in metadata.
  sql(`insert into storage.buckets (id, name, public) values ('spike-meta', 'spike-meta', false) on conflict do nothing;
       create policy spike_meta_insert on storage.objects for insert to authenticated with check (bucket_id = 'spike-meta' and metadata ? 'size');
       create policy spike_meta_select on storage.objects for select to authenticated using (bucket_id = 'spike-meta');`);
  let atInsert: number;
  try {
    const res = await fetch(`${url()}/storage/v1/object/spike-meta/probe.pdf`, {
      method: "POST",
      headers: headers({ "content-type": "application/pdf", "x-upsert": "false" }),
      body: new Uint8Array(body),
    });
    atInsert = res.status;
  } finally {
    sql(`drop policy if exists spike_meta_insert on storage.objects; drop policy if exists spike_meta_select on storage.objects;
         set storage.allow_delete_query = 'true'; delete from storage.objects where bucket_id = 'spike-meta'; delete from storage.buckets where id = 'spike-meta';`);
  }
  record("S4", {
    upload_status: put.status,
    metadata_keys: keys,
    object_size_and_mime_read_by_helpers: values,
    finish_status: finished.status,
    insert_policy_sees_size: atInsert === 200,
    probe_upload_status: atInsert,
  });
  expect(put.status).toBe(200);
  expect(values, "private.object_size/object_mime must read the real keys").toBe(`${body.length} application/pdf`);
  expect(finished.status).toBe(200);
  // Keep the file for S3.
  results.s4_path = begun.path;
});

test("S3: do signed links honour Range?", async () => {
  const path = String(results.s4_path ?? "");
  expect(path).not.toBe("");
  const signed = await (
    await fetch(`${url()}/storage/v1/object/sign/lead-files/${path}`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ expiresIn: 30 }),
    })
  ).json();
  const link = `${url()}/storage/v1${signed.signedURL}`;
  const head = await fetch(link, { headers: { Range: "bytes=0-4" } });
  const headBody = Buffer.from(await head.arrayBuffer());
  const tail = await fetch(link, { headers: { Range: "bytes=-6" } });
  const tailBody = Buffer.from(await tail.arrayBuffer());
  record("S3", {
    head_status: head.status,
    head_bytes: headBody.length,
    head_content_range: head.headers.get("content-range"),
    tail_status: tail.status,
    tail_bytes: tailBody.length,
    range_honoured: head.status === 206 && headBody.length === 5,
  });
  expect([200, 206]).toContain(head.status);
});

test("S5: a signed upload link after the upload was cancelled", async () => {
  const lead = sql(`insert into public.companies (org_id, name) select p.org_id, 'Spike S5 lead ${Date.now()}' from public.profiles p
                    join auth.users u on u.id = p.id where u.email = '${email}' returning id`);
  const body = Buffer.from("%PDF-1.7\n%%EOF\n");
  const call = async (fn: string, args: Record<string, unknown>) =>
    fetch(`${url()}/rest/v1/rpc/${fn}`, { method: "POST", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify(args) });
  const begun = await (await call("begin_file_upload", { p_company: lead, p_name: "s5.pdf", p_mime: "application/pdf", p_size: body.length })).json();
  const sign = await fetch(`${url()}/storage/v1/object/upload/sign/lead-files/${begun.path}`, { method: "POST", headers: headers({ "Content-Type": "application/json" }), body: "{}" });
  const signed = (await sign.json().catch(() => ({}))) as { url?: string };
  const aborted = await call("abort_file_upload", { p_id: begun.id });
  let putStatus: number | null = null;
  try {
    if (signed.url) {
      const put = await fetch(`${url()}/storage/v1${signed.url}`, {
        method: "PUT",
        headers: { "content-type": "application/pdf", "x-upsert": "false", "cache-control": "max-age=0" },
        body: new Uint8Array(body),
      });
      putStatus = put.status;
    }
    record("S5", {
      sign_status: sign.status,
      abort_status: aborted.status,
      put_after_cancel_status: putStatus,
      object_stored_after_cancel: sql(`select count(*) from storage.objects where bucket_id = 'lead-files' and name = '${begun.path}'`) === "1",
      policy_rechecked_at_upload: putStatus !== null && putStatus >= 400,
    });
  } finally {
    // Test-only clean-up of the probe's row and object (the bytes left in CI's container do not matter). storage-api
    // refuses a direct delete unless the session allows it (storage.protect_delete); a leftover probe object harms nothing.
    sql(`delete from public.files where id = '${begun.id}'`);
    try {
      sql(`set storage.allow_delete_query = 'true'; delete from storage.objects where bucket_id = 'lead-files' and name = '${begun.path}'`);
    } catch {
      test.info().annotations.push({ type: "S5 clean-up", description: "probe object left in place" });
    }
  }
  expect(begun.path).toBeTruthy();
  expect(aborted.status).toBe(200);
});
