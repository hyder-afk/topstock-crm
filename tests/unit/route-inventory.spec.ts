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

/** Top-level functions of a file (declarations and `const x = async (...) =>`), with their source text. */
function functions(file: string): Fn[] {
  const text = readFileSync(file, "utf8");
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

const ZOD = /\.safeParse\(|\.parse\(|\bparse[A-Z]\w*\(/;
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

const files = walk(APP);
const routes = files.filter((f) => f.endsWith("/route.ts") && rel(f).startsWith("src/app/api/"));
const pages = files.filter((f) => f.endsWith("/page.tsx"));
const actionFiles = files.filter((f) => /\.tsx?$/.test(f) && /^\s*["']use server["']/.test(readFileSync(f, "utf8")));

test("every page and route is a reviewed screen (no debug or test pages, item 10)", () => {
  const found = [...routes, ...pages].map(rel).sort();
  expect(found.filter((f) => !REVIEWED.has(f)), "not on the reviewed list").toEqual([]);
  expect([...REVIEWED].filter((f) => !found.includes(f)), "listed but gone").toEqual([]);
});

test("every route handler checks the two-factor session and parses what it reads with Zod", () => {
  const problems: string[] = [];
  for (const file of routes) {
    const all = functions(file);
    const handlers = all.filter((f) => f.exported && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(f.name));
    if (handlers.length === 0) problems.push(`${rel(file)}: no handler found`);
    for (const h of handlers) {
      const text = reach(h, all);
      if (PUBLIC_ROUTES.has(rel(file))) {
        if (!/\bassertSameOrigin\(/.test(text)) problems.push(`${rel(file)} ${h.name}: public route without the same-origin check`);
        if (!ZOD.test(text)) problems.push(`${rel(file)} ${h.name}: public route without a Zod parse`);
        continue;
      }
      if (!/\bapiSession\(\)/.test(text)) problems.push(`${rel(file)} ${h.name}: no apiSession()`);
      const readsInput = /\b(searchParams|params|readJsonBody|request\.json|request\.formData|request\.text)\b/.test(text);
      if (readsInput && !ZOD.test(text)) problems.push(`${rel(file)} ${h.name}: reads the request without a Zod parse`);
    }
  }
  expect(problems).toEqual([]);
});

test("every server action checks the two-factor session and parses its input with Zod", () => {
  const problems: string[] = [];
  let count = 0;
  for (const file of actionFiles) {
    const all = functions(file);
    for (const fn of all.filter((f) => f.exported)) {
      count++;
      const key = `${rel(file)}#${fn.name}`;
      const text = reach(fn, all);
      if (!SESSION.test(text) && !(key in PRE_SESSION_ACTIONS)) problems.push(`${key}: no requireSession()/requireAdmin()`);
      if (fn.params > 0 && !NO_INPUT_ACTIONS.has(key) && !ZOD.test(text)) problems.push(`${key}: takes input without a Zod parse`);
    }
  }
  expect(count).toBeGreaterThan(80);
  expect(problems).toEqual([]);
  // The pre-session list holds only actions that exist.
  const existing = new Set(actionFiles.flatMap((f) => functions(f).filter((x) => x.exported).map((x) => `${rel(f)}#${x.name}`)));
  expect(Object.keys(PRE_SESSION_ACTIONS).filter((k) => !existing.has(k))).toEqual([]);
});

test("every page of the app checks the two-factor session itself (the proxy is only the first wall)", () => {
  const problems: string[] = [];
  for (const file of pages.filter((f) => rel(f).startsWith("src/app/(app)/"))) {
    const all = functions(file);
    const page = all.find((f) => f.isDefault);
    if (!page) problems.push(`${rel(file)}: no default export found`);
    else if (!SESSION.test(reach(page, all))) problems.push(`${rel(file)}: no requireSession()/requireAdmin()`);
  }
  expect(problems).toEqual([]);
});

test("the rules catch a planted break (route without a session, action without Zod, unlisted page)", () => {
  const route = `export async function GET(request: Request) { const q = new URL(request.url).searchParams; return Response.json(q); }`;
  const sf = ts.createSourceFile("x.ts", route, ts.ScriptTarget.Latest, true);
  const fn = sf.statements[0] as ts.FunctionDeclaration;
  const text = fn.getText(sf);
  expect(/\bapiSession\(\)/.test(text)).toBe(false);
  expect(ZOD.test(text)).toBe(false);
  const action = `async function helper() { return requireSession(); } export async function act(input: unknown) { await helper(); return input; }`;
  const sf2 = ts.createSourceFile("y.ts", action, ts.ScriptTarget.Latest, true);
  expect(SESSION.test(sf2.getText())).toBe(true); // reached through the helper ...
  expect(ZOD.test(sf2.getText())).toBe(false); // ... but no parse: the action rule would fail
  expect(REVIEWED.has("src/app/(app)/debug/page.tsx")).toBe(false);
});
