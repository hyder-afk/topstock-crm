// LOCAL ONLY smoke test for the PostgREST stand-in scripts/local-auth/gateway.mjs (never run against Supabase).
// The gateway used to hand RPC arguments to psql as `-v` arguments; Linux caps one argument at 128 KB, so a ~700 KB
// import chunk failed. It now writes the SQL to psql's stdin, with every value as a dollar-quoted literal.
//
// Run with the local stack up (bash scripts/local-auth/start.sh applies the probe function and row from local-api.sql):
//   node scripts/local-auth/smoke-large-rpc.mjs
// It reads SUPABASE_LOCAL_URL, SUPABASE_LOCAL_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_LOCAL_DB_URL
// from the stack's env file ($OUT/env, default /tmp/topstock-auth/env), which wins over the shell (the shell may hold
// the dev project's anon key); without the file, from the shell. Both URLs must point at 127.0.0.1 or localhost.
// Sections 8 to 12 check how errors, bodies and filters pass through, on the probe row in local-api.sql.
// Prints one line per check and exits 1 if any check fails.
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { MAX_BODY, literal, newTag, sqlResult } from "./gateway.mjs";

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
const ROWS = `${BASE}/rest/v1/local_gateway_probe_rows`;

let failed = 0;
function check(name, ok, info = "") {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? ` (${info})` : ""}`);
}

const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const auth = (key) => ({ apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" });

async function request(method, url, key, body) {
  const res = await fetch(url, { method, headers: auth(key), body });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON: the check below reports the status
  }
  return { status: res.status, text, json };
}
const call = (key, body) => request("POST", PROBE, key, body);
const setNote = (note) => request("PATCH", `${ROWS}?id=eq.1`, SERVICE, JSON.stringify({ note }));
const getNote = async () => (await request("GET", `${ROWS}?select=note&id=eq.1`, SERVICE)).json?.[0]?.note;
const shown = (r) => `HTTP ${r.status} ${r.text.length > 300 ? `${r.text.slice(0, 300)}...` : r.text}`;

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

// 2. Answer parsing: the error's fields come from local_gateway.run's JSON line on stdout, never from psql's stderr
//    text (a NOTICE there is ignored). When psql itself fails, only the SQLSTATE is taken from stderr: a HINT line
//    there is not read, and stdout is ignored.
{
  const e = sqlResult(
    { status: 0, out: 'error\n{"code": "22023", "hint": "step_up", "message": "refused"}\n', err: "NOTICE:  00000\n" },
    "authenticated",
  );
  check(
    "hint read from the error's JSON",
    !e.ok && e.status === 400 && e.body.code === "22023" && e.body.message === "refused" && e.body.hint === "step_up" && e.body.details === null,
  );
  const f = sqlResult({ status: 3, out: "ok\n[]\n", err: "psql:<stdin>:8: ERROR:  42501\nHINT:  step_up\n" }, "anon");
  check(
    "psql failure: SQLSTATE only, no hint read from stderr",
    !f.ok && f.status === 401 && f.body.code === "42501" && f.body.message === "database error" && f.body.hint === null,
  );
  const g = sqlResult({ status: 2, out: "", err: "psql: error: connection to server failed\n" }, "authenticated");
  check("no SQLSTATE at all: XX000", !g.ok && g.status === 400 && g.body.code === "XX000");
  const ok = sqlResult({ status: 0, out: 'ok\n{"a": 1}\n', err: "" }, "authenticated");
  const none = sqlResult({ status: 0, out: "ok\n", err: "" }, "authenticated");
  check("results pass on as text; SQL null is empty", ok.ok && ok.out === '{"a": 1}' && none.ok && none.out === "");
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

  // Well over the limit with a Content-Length: the body is still read before the 413 goes out, so the client sees the
  // 413 instead of a broken pipe (EPIPE).
  const declared = await new Promise((resolve) => {
    const piece = Buffer.alloc(3 * MAX_BODY, "a");
    const req = http.request(PROBE, { method: "POST", headers: { ...auth(SERVICE), "Content-Length": piece.length } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", (e) => resolve(e.code));
    req.end(piece);
  });
  check("6 MiB with Content-Length: 413, not a broken pipe", declared === 413, `got ${declared}`);
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

// 8. Error fields arrive whole: a line break in a message or detail cannot forge a hint, a multi-line hint keeps every
//    line, the NOTICE raise_with sends first (with its own hint) is not the error, and a value quoted by a 22P02
//    message (as an imported cell would be) stays inside the message.
{
  const raise = (fields) => call(SERVICE, JSON.stringify({ p_payload: { raise_with: fields } }));
  const a = await raise({ message: "refused", detail: "row 7\nHINT:  forged", hint: "step_up" });
  check(
    "a HINT line forged in the detail is ignored; the real hint arrives",
    a.status === 400 && a.json?.code === "22023" && a.json?.message === "refused" && a.json?.hint === "step_up",
    shown(a),
  );
  const b = await raise({ message: "refused\nHINT:  forged" });
  check(
    "a HINT line forged in the message stays in the message; hint null",
    b.status === 400 && b.json?.message === "refused\nHINT:  forged" && b.json?.hint === null,
    shown(b),
  );
  const hint = "first line\nsecond line\nHINT:  third line";
  const c = await raise({ message: "refused", hint });
  check("a multi-line hint arrives whole", c.status === 400 && c.json?.hint === hint, shown(c));
  const d = await call(SERVICE, JSON.stringify({ p_payload: { cast: "12\nHINT:  step_up" } }));
  check(
    "22P02 quoting a value: whole message, no hint",
    d.status === 400 && d.json?.code === "22P02" && d.json?.message === 'invalid input syntax for type integer: "12\nHINT:  step_up"' && d.json?.hint === null,
    shown(d),
  );
}

// 9. Transactions: a call that writes and then fails leaves nothing written; a call that succeeds is committed.
{
  const reset = await setNote("before");
  const bad = await call(SERVICE, JSON.stringify({ p_payload: { write: "after", raise: true } }));
  const kept = await getNote();
  check("a failed call writes nothing", reset.status === 204 && bad.status === 400 && kept === "before", `${shown(bad)}, note ${JSON.stringify(kept)}`);
  const good = await call(SERVICE, JSON.stringify({ p_payload: { write: "after" } }));
  const now = await getNote();
  check("a successful call is committed", good.status === 200 && now === "after", `${shown(good)}, note ${JSON.stringify(now)}`);
}

// 10. The body reaches the database as sent, not as a JSON.parse/JSON.stringify copy (which rounds big numbers and
//     turns 1e400 into null), and the result comes back as the database wrote it.
{
  const big = "123456789012345678901234567890";
  const precise = "0.1000000000000000055511151231257827";
  const r = await call(SERVICE, `{"p_payload":{"echo":{"big":${big},"huge":1e400,"precise":${precise}}}}`);
  const want = `{"big": ${big}, "huge": 1${"0".repeat(400)}, "precise": ${precise}}`;
  check("big numbers reach the database exactly", r.status === 200 && r.json?.echo_text === want, shown(r));
  check("and come back exactly in the result", r.text.includes(`"echo": ${want}`));
}

// 11. Table PATCH then GET on the probe row as service_role: awkward text comes back byte for byte, also as the
//     filter, and so does a ~300 KB value. anon gets nothing (no grant, RLS on): 401 with 42501.
{
  const awkward = "Bob it's $$ \\ :'role' é";
  const p = await setNote(awkward);
  const g = await request("GET", `${ROWS}?select=id,note&note=eq.${encodeURIComponent(awkward)}`, SERVICE);
  check(
    "awkward value: PATCH, then GET filtered by it",
    p.status === 204 && g.status === 200 && g.json?.length === 1 && g.json[0].id === 1 && g.json[0].note === awkward,
    `PATCH HTTP ${p.status}, GET ${shown(g)}`,
  );
  const large = awkward.repeat(Math.ceil((300 * 1024) / Buffer.byteLength(awkward)));
  const p2 = await setNote(large);
  const back = await getNote();
  check(
    `${Buffer.byteLength(large)}-byte value: PATCH, then GET byte for byte`,
    p2.status === 204 && typeof back === "string" && Buffer.from(back, "utf8").equals(Buffer.from(large, "utf8")),
    `PATCH HTTP ${p2.status}, ${typeof back === "string" ? Buffer.byteLength(back) : back} bytes back`,
  );
  const anon = await request("GET", `${ROWS}?select=id`, ANON);
  check("anon cannot read the probe row (401, 42501)", anon.status === 401 && anon.json?.code === "42501", shown(anon));
}

// 12. Filter names: "__proto__", "constructor" and "prototype" reach the database like any other name and are refused
//     as unknown columns (400, 42703), as PostgREST does, so a PATCH filtered only by "__proto__" changes nothing.
//     A repeated filter is refused (400) rather than half applied.
{
  await setNote("untouched");
  for (const name of ["__proto__", "constructor", "prototype"]) {
    const g = await request("GET", `${ROWS}?select=id,note&${name}=eq.x`, SERVICE);
    check(`GET filtered by ${name}: 400, 42703`, g.status === 400 && g.json?.code === "42703", shown(g));
  }
  const p = await request("PATCH", `${ROWS}?__proto__=eq.x`, SERVICE, JSON.stringify({ note: "changed" }));
  const kept = await getNote();
  check(
    "PATCH filtered only by __proto__: 400, 42703, nothing changed",
    p.status === 400 && p.json?.code === "42703" && kept === "untouched",
    `${shown(p)}, note ${JSON.stringify(kept)}`,
  );
  const twice = await request("GET", `${ROWS}?select=id&id=eq.1&id=eq.2`, SERVICE);
  check("a repeated filter: 400", twice.status === 400 && twice.json?.code === "LOCAL", shown(twice));
}

console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
