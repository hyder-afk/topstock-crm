// LOCAL ONLY stand-in for the Supabase API gateway (scripts/local-auth; CI and Vercel use the real Supabase stack).
//   /auth/v1/*  -> Supabase Auth (GoTrue) on :9999
//   /rest/v1/*  -> the few PostgREST behaviours the app uses (rpc calls; table GET/PATCH with eq filters), run by
//                  psql against the throwaway database as the caller's API role with the caller's JWT claims, so row
//                  level security decides exactly as on Supabase. Anything else answers 400 instead of guessing.
// The SQL reaches psql through stdin, never argv (Linux caps one argument at 128 KB, and an import chunk is ~750 KB).
// Every value is written into that SQL text only as a dollar-quoted literal with a random per-request tag; a value
// containing the tag is refused. Names are checked against NAME here and quoted with %I in local-api.sql.
import http from "node:http";
import { spawn } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SECRET = process.env.GOTRUE_JWT_SECRET;
const PG = { host: "127.0.0.1", port: process.env.LOCAL_PG_PORT || "54330" };
const PORT = Number(process.env.LOCAL_GATEWAY_PORT || 54321);
const ROLES = new Set(["anon", "authenticated", "service_role"]);
const NAME = /^[a-z_][a-z0-9_]{0,62}$/;
export const MAX_BODY = 2 * 1024 * 1024;

class LocalError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const localBody = (message) => ({ code: "LOCAL", message: `local gateway: ${message}`, details: null, hint: null });

// A fresh tag per request: 16 random bytes, so a client cannot know it before sending its values.
export function newTag() {
  return `tag_${randomBytes(16).toString("hex")}`;
}

// $tag_<hex>$value$tag_<hex>$. Inside it nothing is escaped or interpolated, by PostgreSQL or by psql (no :variables,
// no backslash commands), so the only way out is the closing tag: any value containing the tag is refused.
export function literal(tag, value) {
  const text = String(value);
  if (text.includes(tag)) throw new LocalError(400, "a value contains the quoting tag");
  return `$${tag}$${text}$${tag}$`;
}

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

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body));
}

// PostgREST's mapping of the SQLSTATEs the app can meet.
function httpStatus(code, role) {
  if (code === "42501") return role === "anon" ? 401 : 403;
  if (code === "P0002" || code === "42883" || code === "42P01") return 404;
  if (code === "23505") return 409;
  return 400;
}

// statement(lit) returns the SQL to run, with every value passed through lit().
function runSql(claims, statement) {
  const tag = newTag();
  const lit = (value) => literal(tag, value);
  const script = [
    "\\set ON_ERROR_STOP 1",
    "\\set VERBOSITY verbose",
    "\\set SHOW_CONTEXT never",
    "begin;",
    `select set_config('role', ${lit(claims.role)}, true) \\g /dev/null`,
    `select set_config('request.jwt.claims', ${lit(JSON.stringify(claims))}, true) \\g /dev/null`,
    `select set_config('request.jwt.claim.sub', ${lit(claims.sub || "")}, true) \\g /dev/null`,
    `select set_config('request.jwt.claim.role', ${lit(claims.role)}, true) \\g /dev/null`,
    `${statement(lit)};`,
    "commit;",
  ].join("\n");
  const args = ["-h", PG.host, "-p", PG.port, "-U", "postgres", "-d", "postgres", "-X", "-q", "-A", "-t"];
  return new Promise((resolve) => {
    const child = spawn("psql", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH, PGCLIENTENCODING: "UTF8" },
    });
    const out = [];
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    // psql can exit before reading all of stdin (database down); its exit status and stderr say why.
    child.stdin.on("error", () => {});
    child.on("error", () => resolve({ status: -1, out: "", err: "" }));
    child.on("close", (status) =>
      resolve({ status, out: Buffer.concat(out).toString("utf8").trim(), err: Buffer.concat(err).toString("utf8") }),
    );
    child.stdin.end(script);
  });
}

// psql prints "psql:<stdin>:N: ERROR:  <SQLSTATE>: <message>", then DETAIL:, HINT:, QUERY: and LOCATION: lines.
// The hint is the first HINT: line of that error. Message and details are passed on as before (details stay null).
export function sqlError(stderr, role) {
  const lines = stderr.split("\n");
  const at = lines.findIndex((l) => /ERROR:\s+[0-9A-Z]{5}:\s/.test(l));
  const m = at >= 0 ? lines[at].match(/ERROR:\s+([0-9A-Z]{5}):\s+(.*)$/) : null;
  let hint = null;
  if (m) {
    for (const line of lines.slice(at + 1)) {
      if (/^(psql:|QUERY:|CONTEXT:|LOCATION:)/.test(line)) break;
      const h = line.match(/^HINT:\s+(.*)$/);
      if (h) {
        hint = h[1];
        break;
      }
    }
  }
  const code = m ? m[1] : "XX000";
  return { status: httpStatus(code, role), body: { code, message: m ? m[2] : "database error", details: null, hint } };
}

// The whole body as UTF-8 JSON, at most MAX_BODY bytes (413 above that).
function readBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"] || 0) > MAX_BODY) {
      reject(new LocalError(413, "request body over 2 MB"));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
      else chunks.length = 0;
    });
    req.on("error", reject);
    req.on("end", () => {
      if (size > MAX_BODY) return reject(new LocalError(413, "request body over 2 MB"));
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new LocalError(400, "invalid JSON body"));
      }
    });
  });
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
    r = await runSql(claims, (lit) => `select local_api.rpc(${lit(parts[1])}, ${lit(JSON.stringify(body))}::jsonb)`);
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
      else return send(res, 400, localBody(`unsupported query ${k}=${v}`));
    }
    if (req.method === "GET") {
      if (!cols || !cols.every((c) => NAME.test(c))) return send(res, 400, localBody("list the columns"));
      r = await runSql(
        claims,
        (lit) =>
          `select local_api.select_rows(${lit(parts[0])}, string_to_array(${lit(cols.join(","))}, ','), ${lit(JSON.stringify(filters))}::jsonb)`,
      );
    } else {
      const body = await readBody(req);
      r = await runSql(
        claims,
        (lit) =>
          `select local_api.update_rows(${lit(parts[0])}, ${lit(JSON.stringify(body))}::jsonb, ${lit(JSON.stringify(filters))}::jsonb)`,
      );
    }
    if (r.status !== 0) {
      const e = sqlError(r.err, claims.role);
      return send(res, e.status, e.body);
    }
    return req.method === "GET" ? send(res, 200, r.out) : send(res, 204);
  }

  return send(res, 400, localBody(`unsupported ${req.method} ${url.pathname}`));
}

function serve() {
  http
    .createServer((req, res) => {
      if (req.url.startsWith("/rest/v1/")) {
        rest(req, res).catch((e) => {
          if (res.headersSent) return;
          // A too-large Content-Length is refused before the body is read, so a 413 closes the connection.
          if (e instanceof LocalError) {
            return send(res, e.status, localBody(e.message), e.status === 413 ? { connection: "close" } : {});
          }
          send(res, 500, { code: "LOCAL", message: "local gateway error", details: null, hint: null });
        });
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
    .listen(PORT, "127.0.0.1");
}

// Started by start.sh (`node gateway.mjs`); the smoke test imports literal() and sqlError() without starting a server.
function isMain() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}
if (isMain()) serve();
