// LOCAL ONLY stand-in for the Supabase API gateway (scripts/local-auth; CI and Vercel use the real Supabase stack).
//   /auth/v1/*  -> Supabase Auth (GoTrue) on :9999
//   /rest/v1/*  -> the few PostgREST behaviours the app uses (rpc calls; table GET/PATCH with eq filters), run by
//                  psql against the throwaway database as the caller's API role with the caller's JWT claims, so row
//                  level security decides exactly as on Supabase. Anything else answers 400 instead of guessing.
import http from "node:http";
import { spawn } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET = process.env.GOTRUE_JWT_SECRET;
const PG = { host: "127.0.0.1", port: process.env.LOCAL_PG_PORT || "54330" };
const ROLES = new Set(["anon", "authenticated", "service_role"]);
const NAME = /^[a-z_][a-z0-9_]{0,62}$/;

function verify(token) {
  const [h, p, s] = (token || "").split(".");
  if (!h || !p || !s || !SECRET) return null;
  const expected = createHmac("sha256", SECRET).update(`${h}.${p}`).digest();
  const given = Buffer.from(s, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  if (claims.exp && claims.exp < Date.now() / 1000) return null;
  return ROLES.has(claims.role) ? claims : null;
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body));
}

// PostgREST's mapping of the SQLSTATEs the app can meet.
function httpStatus(code, role) {
  if (code === "42501") return role === "anon" ? 401 : 403;
  if (code === "P0002" || code === "42883" || code === "42P01") return 404;
  if (code === "23505") return 409;
  return 400;
}

function runSql(claims, statement, vars) {
  const script = [
    "\\set ON_ERROR_STOP 1",
    "\\set VERBOSITY verbose",
    "begin;",
    "select set_config('role', :'role', true) \\g /dev/null",
    "select set_config('request.jwt.claims', :'claims', true) \\g /dev/null",
    "select set_config('request.jwt.claim.sub', :'sub', true) \\g /dev/null",
    "select set_config('request.jwt.claim.role', :'role', true) \\g /dev/null",
    `${statement};`,
    "commit;",
  ].join("\n");
  const args = ["-h", PG.host, "-p", PG.port, "-U", "postgres", "-d", "postgres", "-X", "-q", "-A", "-t"];
  const all = { role: claims.role, claims: JSON.stringify(claims), sub: claims.sub || "", ...vars };
  for (const [k, v] of Object.entries(all)) args.push("-v", `${k}=${v}`);
  return new Promise((resolve) => {
    const child = spawn("psql", args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (status) => resolve({ status, out: out.trim(), err }));
    child.stdin.end(script);
  });
}

function sqlError(err, role) {
  const m = err.match(/ERROR:\s+([0-9A-Z]{5}):\s+([^\n]*)/);
  const code = m ? m[1] : "XX000";
  return { status: httpStatus(code, role), body: { code, message: m ? m[2] : "database error", details: null, hint: null } };
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

async function rest(req, res) {
  const url = new URL(req.url, "http://local");
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || req.headers.apikey;
  const claims = verify(bearer);
  if (!claims) return send(res, 401, { code: "PGRST301", message: "JWT invalid", details: null, hint: null });
  const parts = url.pathname.replace(/^\/rest\/v1\/?/, "").split("/");

  let r;
  if (parts[0] === "rpc" && NAME.test(parts[1] || "") && req.method === "POST") {
    const body = await readBody(req);
    r = await runSql(claims, "select local_api.rpc(:'fn', :'args'::jsonb)", { fn: parts[1], args: JSON.stringify(body) });
    if (r.status !== 0) {
      const e = sqlError(r.err, claims.role);
      return send(res, e.status, e.body);
    }
    return r.out === "" ? send(res, 204) : send(res, 200, r.out);
  }

  if (parts.length === 1 && NAME.test(parts[0]) && (req.method === "GET" || req.method === "PATCH")) {
    const filters = {};
    let cols = null;
    for (const [k, v] of url.searchParams) {
      if (k === "select") cols = v.split(",").map((c) => c.trim());
      else if (NAME.test(k) && v.startsWith("eq.")) filters[k] = v.slice(3);
      else return send(res, 400, { code: "LOCAL", message: `local gateway: unsupported query ${k}=${v}`, details: null, hint: null });
    }
    if (req.method === "GET") {
      if (!cols || !cols.every((c) => NAME.test(c))) return send(res, 400, { code: "LOCAL", message: "local gateway: list the columns", details: null, hint: null });
      r = await runSql(claims, "select local_api.select_rows(:'tbl', string_to_array(:'cols', ','), :'filters'::jsonb)", {
        tbl: parts[0], cols: cols.join(","), filters: JSON.stringify(filters),
      });
    } else {
      const body = await readBody(req);
      r = await runSql(claims, "select local_api.update_rows(:'tbl', :'vals'::jsonb, :'filters'::jsonb)", {
        tbl: parts[0], vals: JSON.stringify(body), filters: JSON.stringify(filters),
      });
    }
    if (r.status !== 0) {
      const e = sqlError(r.err, claims.role);
      return send(res, e.status, e.body);
    }
    return req.method === "GET" ? send(res, 200, r.out) : send(res, 204);
  }

  return send(res, 400, { code: "LOCAL", message: `local gateway: unsupported ${req.method} ${url.pathname}`, details: null, hint: null });
}

http
  .createServer((req, res) => {
    if (req.url.startsWith("/rest/v1/")) {
      rest(req, res).catch(() => send(res, 500, { code: "LOCAL", message: "local gateway error", details: null, hint: null }));
      return;
    }
    if (!req.url.startsWith("/auth/v1/")) return send(res, 404, {});
    const path = req.url.slice("/auth/v1".length);
    const up = http.request({ host: "127.0.0.1", port: 9999, path, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  })
  .listen(54321, "127.0.0.1");
