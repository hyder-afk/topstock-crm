// LOCAL ONLY smoke test for the PostgREST stand-in scripts/local-auth/gateway.mjs (never run against Supabase).
// The gateway used to hand RPC arguments to psql as `-v` arguments; Linux caps one argument at 128 KB, so a ~700 KB
// import chunk failed. It now writes the SQL to psql's stdin, with every value as a dollar-quoted literal.
//
// Run with the local stack up (bash scripts/local-auth/start.sh applies the probe function from local-api.sql):
//   node scripts/local-auth/smoke-large-rpc.mjs
// It reads SUPABASE_LOCAL_URL, SUPABASE_LOCAL_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_LOCAL_DB_URL
// from the stack's env file ($OUT/env, default /tmp/topstock-auth/env), which wins over the shell (the shell may hold
// the dev project's anon key); without the file, from the shell. Both URLs must point at 127.0.0.1 or localhost.
// Prints one line per check and exits 1 if any check fails.
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { MAX_BODY, literal, newTag, sqlError } from "./gateway.mjs";

const envFile = `${process.env.OUT || "/tmp/topstock-auth"}/env`;
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2];
  }
}

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (start the stack: bash scripts/local-auth/start.sh)`);
  if (name.endsWith("_URL") && !["127.0.0.1", "localhost"].includes(new URL(v).hostname)) {
    throw new Error(`${name} must point at a local stack (127.0.0.1 or localhost)`);
  }
  return v;
}

const BASE = env("SUPABASE_LOCAL_URL");
const DB = env("SUPABASE_LOCAL_DB_URL");
const SERVICE = env("SUPABASE_LOCAL_SERVICE_ROLE_KEY");
const ANON = env("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const PROBE = `${BASE}/rest/v1/rpc/local_gateway_probe`;

let failed = 0;
function check(name, ok, info = "") {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? ` (${info})` : ""}`);
}

const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const auth = (key) => ({ apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" });

async function call(key, body) {
  const res = await fetch(PROBE, { method: "POST", headers: auth(key), body });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON: the check below reports the status
  }
  return { status: res.status, json };
}

function psql(script) {
  return new Promise((resolve) => {
    const child = spawn("psql", [DB, "-X", "-q", "-A", "-t"], { env: { PATH: process.env.PATH, PGCLIENTENCODING: "UTF8" } });
    const out = [];
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.stdin.on("error", () => {});
    child.on("close", (status) =>
      resolve({ status, out: Buffer.concat(out).toString("utf8"), err: Buffer.concat(err).toString("utf8") }),
    );
    child.stdin.end(script);
  });
}

// 1. Quoting, straight through psql's stdin as the gateway does it: values come back byte for byte, and psql
//    interpolates nothing inside the literal (no :variables, no backslash commands such as \echo or \q).
{
  const tag = newTag();
  let refused = false;
  try {
    literal(tag, `x${tag}y`);
  } catch (e) {
    refused = e.status === 400;
  }
  check("a value containing the tag is refused (400)", refused);

  const values = [
    "", "abc$", "$", "$$", "$x$", "$tag$", "it's", "back\\slash", ":'role' :role :\"role\"", "\\echo injected",
    "line one\n\\q\nline three", "é ü ß 😀 漢字", `$${tag.slice(0, 20)}$`,
  ];
  const script = ["\\set ON_ERROR_STOP 1", ...values.map((v) => `select encode(convert_to(${literal(tag, v)}, 'UTF8'), 'hex');`)].join("\n");
  const r = await psql(script);
  const got = r.out.split("\n").filter((l, i, all) => i < all.length - 1 || l !== "");
  const want = values.map((v) => Buffer.from(v, "utf8").toString("hex"));
  check("tricky values round-trip through psql stdin", r.status === 0 && JSON.stringify(got) === JSON.stringify(want), r.err.trim());
}

// 2. Error parsing: the hint of the error is kept, a NOTICE's hint before it is not.
{
  const e = sqlError(
    [
      "psql:<stdin>:3: NOTICE:  00000: unrelated",
      "HINT:  not_this_one",
      "psql:<stdin>:8: ERROR:  22023: refused",
      "DETAIL:  some detail",
      "HINT:  step_up",
      "LOCATION:  exec_stmt_raise, pl_exec.c:3911",
    ].join("\n"),
    "authenticated",
  );
  check("hint parsed from the error", e.status === 400 && e.body.code === "22023" && e.body.message === "refused" && e.body.hint === "step_up");
  check("no hint when the error has none", sqlError("psql:<stdin>:8: ERROR:  42501: permission denied\n", "anon").body.hint === null);
}

// 3. A ~700 KB argument reaches the database intact, as the caller's role.
{
  const unit = `Société Générale d'Import $tag$ $$ \\g /dev/null :'role' "quoted" é😀漢 \n\t`;
  const blob = unit.repeat(Math.floor(716_800 / (Buffer.byteLength(JSON.stringify(unit)) - 2)));
  const body = JSON.stringify({ p_payload: { blob } });
  const size = Buffer.byteLength(body);
  const r = await call(SERVICE, body);
  check(
    `${size}-byte RPC body (~700 KB) reaches the database intact`,
    r.status === 200 && r.json?.bytes === Buffer.byteLength(blob) && r.json?.md5 === md5(blob),
    `HTTP ${r.status}, ${r.json?.bytes} bytes in the database, sent ${Buffer.byteLength(blob)}`,
  );
  check("it ran as service_role with its claims", r.json?.role === "service_role" && r.json?.jwt_role === "service_role");

  const a = await call(ANON, body);
  check("the same call as anon is refused by the database (401, 42501)", a.status === 401 && a.json?.code === "42501", `HTTP ${a.status} ${JSON.stringify(a.json)}`);
}

// 4. PostgreSQL's HINT reaches the JSON error body; message and details as before.
{
  const r = await call(SERVICE, JSON.stringify({ p_payload: { raise: true } }));
  check(
    "error body carries the hint",
    r.status === 400 && r.json?.code === "22023" && r.json?.message === "local probe refused" && r.json?.hint === "local_probe_hint" && r.json?.details === null,
    `HTTP ${r.status} ${JSON.stringify(r.json)}`,
  );
}

// 5. Body limit: exactly 2 MiB is accepted; one byte more is refused with 413, with or without a Content-Length.
{
  const head = '{"p_payload":{"blob":"';
  const tail = '"}}';
  const exact = head + "a".repeat(MAX_BODY - head.length - tail.length) + tail;
  const ok = await call(SERVICE, exact);
  check("a 2 MiB body is accepted", ok.status === 200 && ok.json?.bytes === MAX_BODY - head.length - tail.length, `HTTP ${ok.status}`);

  const over = head + "a".repeat(MAX_BODY - head.length - tail.length + 1) + tail;
  const big = await call(SERVICE, over);
  check("2 MiB + 1 byte with Content-Length: 413", big.status === 413, `HTTP ${big.status}`);

  const chunked = await new Promise((resolve) => {
    const req = http.request(PROBE, { method: "POST", headers: { ...auth(SERVICE), "Transfer-Encoding": "chunked" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", (e) => resolve(e.code));
    const piece = Buffer.from(over);
    for (let i = 0; i < piece.length; i += 65_536) req.write(piece.subarray(i, i + 65_536));
    req.end();
  });
  check("2 MiB + 1 byte chunked (no Content-Length): 413", chunked === 413, `got ${chunked}`);
}

// 6. Unchanged behaviour: no token is 401, a body that is not JSON is 400.
{
  const res = await fetch(PROBE, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check("no token: 401", res.status === 401);
  const bad = await call(SERVICE, "{not json");
  check("invalid JSON: 400", bad.status === 400 && bad.json?.code === "LOCAL", `HTTP ${bad.status}`);
}

// 7. Table GET and PATCH go through the same stdin path. The local database grants service_role nothing on profiles
//    (the app's migrations grant authenticated only), so the database itself must refuse: 403 with 42501 shows the
//    statement parsed with the tricky values (a broken literal would be a 42601 syntax error, 400) and ran as
//    service_role, not as the superuser psql connects as (which would get 200).
{
  const tricky = encodeURIComponent("it's $$ \\ :'role' $tag$");
  const denied = (r, j) => r.status === 403 && j?.code === "42501" && j?.message === "permission denied for table profiles";
  const get = await fetch(`${BASE}/rest/v1/profiles?select=id,first_name&first_name=eq.${tricky}`, { headers: auth(SERVICE) });
  const g = await get.json().catch(() => null);
  check("table GET with a tricky filter runs as the caller (403, 42501)", denied(get, g), `HTTP ${get.status} ${JSON.stringify(g)}`);
  const patch = await fetch(`${BASE}/rest/v1/profiles?id=eq.00000000-0000-0000-0000-000000000000&first_name=eq.${tricky}`, {
    method: "PATCH",
    headers: auth(SERVICE),
    body: JSON.stringify({ first_name: "it's $$ \\" }),
  });
  const p = await patch.json().catch(() => null);
  check("table PATCH with a tricky body runs as the caller (403, 42501)", denied(patch, p), `HTTP ${patch.status} ${JSON.stringify(p)}`);
}

console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
