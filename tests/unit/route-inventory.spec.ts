import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, test } from "@playwright/test";
import ts from "typescript";

// Gate 1 route inventory (Master Plan section 8 items 5, 9, 10 and 16; Day 7 plan step 7a), Day 7d. Reads every route
// handler, server action file and app page with the TypeScript parser and fails when one of them:
//   - a route handler under src/app/api does not reach apiSession() (the two-factor session check, 401 otherwise),
//     unless it is one of the public share routes, which must reach their same-origin check and a Zod parse instead;
//   - a route handler that reads the request (its query, path params or body) does not reach a Zod parse;
//   - an exported server action ("use server") does not reach requireSession() or requireAdmin(), unless it is one of
//     the sign-in steps listed below (they run before a full session exists and check the session's stage themselves);
//   - an exported server action that takes input does not reach a Zod parse;
//   - a page under src/app/(app) does not reach requireSession() or requireAdmin() (the proxy is only the first wall);
//   - a page, route or action exists that is not on the reviewed list of screens below (no debug or test pages).
// "Reaches" means: the exported function's own text, or the text of a function declared in the same file that it calls,
// directly or through another such function. A new file fails until it follows the rules (and is listed).

const ROOT = process.cwd();
const APP = join(ROOT, "src/app");

function walk(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
const rel = (f: string) => relative(ROOT, f).split(sep).join("/");

type Fn = { name: string; text: string; exported: boolean; isDefault: boolean; params: number };

/** Top-level functions of a file's text (declarations and `const x = async (...) =>`), with their source text. */
function functions(file: string, text: string): Fn[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Fn[] = [];
  const mods = (n: ts.Node) => (ts.canHaveModifiers(n) ? (ts.getModifiers(n) ?? []) : []);
  for (const st of sf.statements) {
    const exported = mods(st).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = mods(st).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (ts.isFunctionDeclaration(st) && st.body) {
      out.push({ name: st.name?.text ?? "default", text: st.getText(sf), exported, isDefault, params: st.parameters.length });
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const init = d.initializer;
        if (ts.isIdentifier(d.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          out.push({ name: d.name.text, text: d.getText(sf), exported, isDefault: false, params: init.parameters.length });
        }
      }
    }
  }
  return out;
}

/** The text of `fn` and of every same-file function it calls, transitively. */
function reach(fn: Fn, all: Fn[]) {
  const byName = new Map(all.map((f) => [f.name, f]));
  const seen = new Set<string>([fn.name]);
  const queue = [fn];
  let text = "";
  while (queue.length) {
    const f = queue.shift()!;
    text += "\n" + f.text;
    for (const m of f.text.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\(/g)) {
      const g = byName.get(m[1]);
      if (g && !seen.has(g.name)) {
        seen.add(g.name);
        queue.push(g);
      }
    }
  }
  return text;
}

// A Zod parse: .safeParse(, .parse( (but not JSON.parse), or a parseXxx( helper (but not parseInt or parseFloat).
const ZOD = /\.safeParse\(|(?<!JSON)\.parse\(|\bparse(?!Int\b|Float\b)[A-Z]\w*\(/;
const SESSION = /\b(requireSession|requireAdmin)\(/;

// Sign-in steps that run before a full (aal2) session exists; each checks the session's stage itself (getGate) or needs
// none (asking for a reset link, choosing the language). Reviewed in Day 1 and Day 7d.
const PRE_SESSION_ACTIONS: Record<string, string> = {
  "src/app/(auth)/actions.ts#signIn": "the password step: no session yet",
  "src/app/(auth)/actions.ts#signOut": "ends whatever session there is; reads no data",
  "src/app/(auth)/actions.ts#requestPasswordReset": "same answer for every address; Supabase limits it",
  "src/app/(auth)/actions.ts#confirmEmailLink": "turns a one-time link into a session",
  "src/app/(auth)/actions.ts#setPassword": "getGate(): signed-out goes to sign-in, an authenticator is asked for first",
  "src/app/(auth)/actions.ts#startTotpEnrollment": "getGate(): only a password-only session with no authenticator",
  "src/app/(auth)/actions.ts#verifyTotpEnrollment": "getGate(): only a password-only session with no authenticator",
  "src/app/(auth)/actions.ts#verifyTotp": "getGate(): the second step of sign-in",
  "src/app/actions.ts#setLocale": "sets the language cookie only (Zod enum en|fr); reads and writes no data",
};
// Server actions without input of their own (nothing to parse).
const NO_INPUT_ACTIONS = new Set(["src/app/(auth)/actions.ts#signOut", "src/app/(auth)/actions.ts#signOutEverywhere", "src/app/(auth)/actions.ts#startTotpEnrollment"]);

// The public share routes (Day 6e): signed-out by design, no cookie read; same-origin check, body cap and Zod instead.
const PUBLIC_ROUTES = new Set(["src/app/api/share/view/route.ts", "src/app/api/share/request/route.ts"]);

// Every screen and endpoint, reviewed against Master Plan section 5 (Day 7d). Item 10: nothing else may exist.
const REVIEWED = new Set([
  // signed-out and sign-in steps
  "src/app/(auth)/login/page.tsx", "src/app/(auth)/forgot-password/page.tsx", "src/app/(auth)/auth/confirm/page.tsx",
  "src/app/(auth)/mfa/page.tsx", "src/app/(auth)/mfa/setup/page.tsx", "src/app/(auth)/set-password/page.tsx",
  // the client stock link (Day 6e)
  "src/app/(share)/s/[locale]/page.tsx", "src/app/api/share/request/route.ts", "src/app/api/share/view/route.ts",
  // the app's screens
  "src/app/(app)/page.tsx", "src/app/(app)/analytics/page.tsx", "src/app/(app)/files/unavailable/page.tsx",
  "src/app/(app)/inventory/page.tsx", "src/app/(app)/inventory/client-view/page.tsx", "src/app/(app)/inventory/import/page.tsx",
  "src/app/(app)/inventory/p/[id]/page.tsx", "src/app/(app)/inventory/settings/page.tsx", "src/app/(app)/leads/page.tsx",
  "src/app/(app)/leads/[id]/page.tsx", "src/app/(app)/leads/import/page.tsx", "src/app/(app)/leads/queue/page.tsx",
  "src/app/(app)/more/page.tsx", "src/app/(app)/more/team/page.tsx", "src/app/(app)/pipeline/page.tsx", "src/app/(app)/tasks/page.tsx",
  // the app's JSON reads and the queue's writes
  "src/app/api/activities/[id]/route.ts", "src/app/api/deals/[id]/route.ts", "src/app/api/files/[id]/route.ts",
  "src/app/api/home/route.ts", "src/app/api/imports/[id]/issues/route.ts", "src/app/api/inventory/alerts/route.ts",
  "src/app/api/inventory/movements/route.ts", "src/app/api/inventory/products/[id]/route.ts",
  "src/app/api/inventory/requests/[id]/route.ts", "src/app/api/inventory/requests/route.ts",
  "src/app/api/inventory/reservations/route.ts", "src/app/api/inventory/sales/[id]/route.ts", "src/app/api/inventory/sales/route.ts",
  "src/app/api/inventory/share-links/route.ts", "src/app/api/inventory/share-preview/route.ts", "src/app/api/inventory/stock/route.ts",
  "src/app/api/inventory/summary/route.ts", "src/app/api/leads/[id]/activities/route.ts", "src/app/api/leads/[id]/deals/route.ts",
  "src/app/api/leads/[id]/files/route.ts", "src/app/api/leads/[id]/route.ts", "src/app/api/leads/[id]/stock/route.ts",
  "src/app/api/leads/[id]/tasks/route.ts", "src/app/api/leads/route.ts", "src/app/api/pipeline/board/route.ts",
  "src/app/api/pipeline/stage/route.ts", "src/app/api/pipeline/summary/route.ts", "src/app/api/queue/next/route.ts",
  "src/app/api/queue/outcome/route.ts", "src/app/api/queue/release/route.ts", "src/app/api/queue/summary/route.ts",
  "src/app/api/stock-imports/[id]/changes/route.ts", "src/app/api/stock-imports/[id]/issues/route.ts", "src/app/api/tasks/route.ts",
]);

// The rules, as functions of a file's repository path and text, so the tests below run them on the real files and the
// planted-break test runs the very same code on in-memory fixtures.
function routeProblems(path: string, text: string): string[] {
  const problems: string[] = [];
  const all = functions(path, text);
  const handlers = all.filter((f) => f.exported && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(f.name));
  if (handlers.length === 0) problems.push(`${path}: no handler found`);
  for (const h of handlers) {
    const body = reach(h, all);
    if (PUBLIC_ROUTES.has(path)) {
      if (!/\bassertSameOrigin\(/.test(body)) problems.push(`${path} ${h.name}: public route without the same-origin check`);
      if (!ZOD.test(body)) problems.push(`${path} ${h.name}: public route without a Zod parse`);
      continue;
    }
    if (!/\bapiSession\(\)/.test(body)) problems.push(`${path} ${h.name}: no apiSession()`);
    const readsInput = /\b(searchParams|params|readJsonBody|request\.json|request\.formData|request\.text)\b/.test(body);
    if (readsInput && !ZOD.test(body)) problems.push(`${path} ${h.name}: reads the request without a Zod parse`);
  }
  return problems;
}

function actionProblems(path: string, text: string): { problems: string[]; exported: string[] } {
  const problems: string[] = [];
  const all = functions(path, text);
  const exported = all.filter((f) => f.exported);
  for (const fn of exported) {
    const key = `${path}#${fn.name}`;
    const body = reach(fn, all);
    if (!SESSION.test(body) && !(key in PRE_SESSION_ACTIONS)) problems.push(`${key}: no requireSession()/requireAdmin()`);
    if (fn.params > 0 && !NO_INPUT_ACTIONS.has(key) && !ZOD.test(body)) problems.push(`${key}: takes input without a Zod parse`);
  }
  return { problems, exported: exported.map((f) => `${path}#${f.name}`) };
}

function pageProblems(path: string, text: string): string[] {
  const all = functions(path, text);
  const page = all.find((f) => f.isDefault);
  if (!page) return [`${path}: no default export found`];
  return SESSION.test(reach(page, all)) ? [] : [`${path}: no requireSession()/requireAdmin()`];
}

function screenProblems(found: string[]): string[] {
  return [
    ...found.filter((f) => !REVIEWED.has(f)).map((f) => `${f}: not on the reviewed list`),
    ...[...REVIEWED].filter((f) => !found.includes(f)).map((f) => `${f}: listed but gone`),
  ];
}

const files = walk(APP);
const routes = files.filter((f) => f.endsWith("/route.ts") && rel(f).startsWith("src/app/api/"));
const pages = files.filter((f) => f.endsWith("/page.tsx"));
const actionFiles = files.filter((f) => /\.tsx?$/.test(f) && /^\s*["']use server["']/.test(readFileSync(f, "utf8")));

const read = (f: string) => readFileSync(f, "utf8");

test("every page and route is a reviewed screen (no debug or test pages, item 10)", () => {
  expect(screenProblems([...routes, ...pages].map(rel).sort())).toEqual([]);
});

test("every route handler checks the two-factor session and parses what it reads with Zod", () => {
  expect(routes.length).toBeGreaterThan(30);
  expect(routes.flatMap((f) => routeProblems(rel(f), read(f)))).toEqual([]);
});

test("every server action checks the two-factor session and parses its input with Zod", () => {
  const results = actionFiles.map((f) => actionProblems(rel(f), read(f)));
  expect(results.flatMap((r) => r.exported).length).toBeGreaterThan(80);
  expect(results.flatMap((r) => r.problems)).toEqual([]);
  // The pre-session list holds only actions that exist.
  const existing = new Set(results.flatMap((r) => r.exported));
  expect(Object.keys(PRE_SESSION_ACTIONS).filter((k) => !existing.has(k))).toEqual([]);
});

test("every page of the app checks the two-factor session itself (the proxy is only the first wall)", () => {
  const appPages = pages.filter((f) => rel(f).startsWith("src/app/(app)/"));
  expect(appPages.length).toBeGreaterThan(10);
  expect(appPages.flatMap((f) => pageProblems(rel(f), read(f)))).toEqual([]);
});

// Planted breaks: the same rule functions on in-memory files. Each fixture must give exactly the named problem, and a
// correct twin must give none (so a rule that flags everything fails too). Evidence: docs/evidence/day7d/route-inventory.md.
const ROUTE = "src/app/api/planted/route.ts";
test("planted break: a route without apiSession() is caught", () => {
  const bad = `import { z } from "zod";
export async function GET(request: Request) { const q = z.string().safeParse(new URL(request.url).searchParams.get("q")); return Response.json(q); }`;
  expect(routeProblems(ROUTE, bad)).toEqual([`${ROUTE} GET: no apiSession()`]);
  expect(routeProblems(ROUTE, bad.replace("{ const q", "{ const s = await apiSession(); if (!s) return null; const q"))).toEqual([]);
});

test("planted break: a route that reads its body with JSON.parse only (no Zod) is caught", () => {
  const bad = `export async function POST(request: Request) { const s = await apiSession(); if (!s) return null;
  const body = JSON.parse(await request.text()); const n = parseInt(body.n); const f = parseFloat(body.f); return Response.json({ n, f }); }`;
  expect(routeProblems(ROUTE, bad)).toEqual([`${ROUTE} POST: reads the request without a Zod parse`]);
  expect(routeProblems(ROUTE, bad.replace("const n =", "const ok = schema.safeParse(body); const n ="))).toEqual([]);
});

test("planted break: a route whose helper parses is accepted, and the helper is found through reach()", () => {
  const good = `async function readQuery(request: Request) { return z.object({}).safeParse(Object.fromEntries(new URL(request.url).searchParams)); }
export async function GET(request: Request) { const s = await apiSession(); if (!s) return null; return Response.json(await readQuery(request)); }`;
  expect(routeProblems(ROUTE, good)).toEqual([]);
});

const ACTIONS = "src/app/(app)/planted/actions.ts";
test("planted break: a server action without Zod is caught (its session check reached through a helper)", () => {
  const bad = `"use server";
async function session() { return requireSession(); }
export async function act(input: unknown) { const { supabase } = await session(); return supabase.rpc("x", input as never); }`;
  expect(actionProblems(ACTIONS, bad).problems).toEqual([`${ACTIONS}#act: takes input without a Zod parse`]);
  expect(actionProblems(ACTIONS, bad.replace("const { supabase }", "const p = inputSchema.safeParse(input); const { supabase }")).problems).toEqual([]);
});

test("planted break: a server action without requireSession() is caught", () => {
  const bad = `"use server";
export async function act(input: unknown) { const p = inputSchema.safeParse(input); return p.success; }`;
  expect(actionProblems(ACTIONS, bad).problems).toEqual([`${ACTIONS}#act: no requireSession()/requireAdmin()`]);
});

test("planted break: an unlisted page (and an app page without a session check) is caught", () => {
  const page = "src/app/(app)/debug/page.tsx";
  const found = [...[...routes, ...pages].map(rel), page].sort();
  expect(screenProblems(found)).toEqual([`${page}: not on the reviewed list`]);
  expect(pageProblems(page, `export default async function Debug() { return null; }`)).toEqual([`${page}: no requireSession()/requireAdmin()`]);
  expect(pageProblems(page, `export default async function Debug() { await requireSession(); return null; }`)).toEqual([]);
});
