#!/usr/bin/env node
// Day 7b source check (Haider 15 Oct 2026: "do not keep any native pickers or popups on the app"). Fails when any of
// these come back in src/ outside src/components/ui (where the app's own pickers live):
//   native-select     a raw <select> (use Select or Combobox from @/components/ui)
//   native-input      type="date" | "time" | "datetime-local" | "month" | "week" | "color" | "search" on any element
//                     (use DatePicker, TimePicker, DateTimePicker, SearchInput)
//   native-datalist   <datalist> (the browser's suggestion popup; use Combobox)
//   title-tooltip     title= on an HTML element or on a component that passes it to one (Link, Button, Input, ...)
//                     (use Tooltip on focusable things, visible or screen-reader text elsewhere)
//   native-disclosure a raw <details>/<summary> (use Disclosure: our own chevron, no browser triangle)
//   native-dialog     window.confirm / alert / prompt, called bare or through window/globalThis/self
//                     (use the app's Dialog)
//   form-validate     a <form> without noValidate (errors go in FormMessage, never the browser's bubble)
//   native-validity   reportValidity() / setCustomValidity() (the bubble, called by hand)
//   native-leave-prompt the browser's "Leave site?" prompt: preventDefault() or returnValue= in a beforeunload
//                     handler, or any onbeforeunload= (ALLOWED below holds the one use Haider kept)
// It reads the code with the TypeScript parser (no regex on JSX), so a component prop called `title` (Card, ListState)
// or a local function called `confirm` is not a finding. Run: node scripts/check-native-controls.mjs [dir ...]
// The rules are unit-tested in tests/unit/native-controls.spec.ts, which also runs this check over src/.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

const NATIVE_TYPES = new Set(["date", "time", "datetime-local", "month", "week", "color", "search"]);
// Components that hand `title` straight to a DOM element, so title= on them is the browser's tooltip too.
const DOM_FORWARDING = new Set(["Link", "Button", "Input", "Textarea", "Label", "Kbd", "Image"]);
const DIALOGS = new Set(["confirm", "alert", "prompt"]);
const GLOBALS = new Set(["window", "globalThis", "self"]);
// The app's own components may wrap the native elements they replace.
const EXEMPT_DIRS = [["src", "components", "ui"].join("/")];

export const RULES = {
  "native-select": "a raw <select>: use Select (or Combobox for long lists) from @/components/ui",
  "native-input": "a native date/time/search input: use DatePicker, TimePicker, DateTimePicker or SearchInput",
  "native-datalist": "a <datalist> suggestion popup: use Combobox",
  "title-tooltip": "title= shows the browser's tooltip: use Tooltip on a focusable element, or visible / sr-only text",
  "native-disclosure": "a raw <details>/<summary>: use Disclosure from @/components/ui/disclosure",
  "native-dialog": "window.confirm/alert/prompt: use the app's Dialog",
  "form-validate": "a <form> without noValidate: add noValidate and show errors in FormMessage",
  "native-validity": "reportValidity/setCustomValidity shows the browser's bubble: use FormMessage",
  "native-leave-prompt": "the browser's \"Leave site?\" prompt: keep the work safe in the app instead (only ALLOWED may ask)",
  "stale-allowance": "an ALLOWED native use is gone or moved: update ALLOWED in scripts/check-native-controls.mjs",
};

// The native uses Haider kept, each exactly once. Anything more in that file, or the same use anywhere else, fails.
export const ALLOWED = [
  {
    file: "src/components/import/import-workspace.tsx",
    rule: "native-leave-prompt",
    // Haider's decision (15 Oct 2026, builder's recommendation, docs/log.md): while a lead import is sending or
    // importing rows, the browser asks "Leave site?" before the tab closes or reloads. No page can replace it: once the
    // tab is closing, only the browser can still ask, and closing would pause the import.
    count: 1,
  },
];

function tagName(node) {
  const t = node.tagName;
  if (ts.isIdentifier(t)) return t.text;
  if (ts.isPropertyAccessExpression(t)) return t.getText(); // motion.div
  return t.getText();
}

// An intrinsic HTML element (lowercase), or motion.div and the like.
function isDomTag(name) {
  if (/^[a-z]/.test(name)) return true;
  return /^motion\.[a-z]/.test(name);
}

function attr(node, name) {
  return node.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText() === name);
}

// Every string literal an attribute's value can be: "date", {"date"}, {cond ? "date" : "text"}, {`date`}.
function literalValues(init) {
  if (!init) return [];
  if (ts.isStringLiteral(init)) return [init.text];
  const out = [];
  const visit = (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
    ts.forEachChild(n, visit);
  };
  if (ts.isJsxExpression(init) && init.expression) visit(init.expression);
  return out;
}

// Names a file declares itself (functions, variables, parameters, imports): a call to a local `confirm()` is fine.
function declaredNames(sf) {
  const names = new Set();
  const visit = (n) => {
    if ((ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isImportSpecifier(n) || ts.isImportClause(n)) && n.name && ts.isIdentifier(n.name)) {
      names.add(n.name.text);
    }
    if (ts.isBindingElement(n) && ts.isIdentifier(n.name)) names.add(n.name.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return names;
}

/** Findings for one file's source text: [{ rule, line, text }]. */
export function scanSource(text, fileName = "file.tsx") {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : fileName.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const declared = declaredNames(sf);
  const findings = [];
  const add = (rule, node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    findings.push({ rule, line: line + 1, text: node.getText(sf).split("\n")[0].slice(0, 120) });
  };

  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = tagName(node);
      const dom = isDomTag(name);
      if (name === "select") add("native-select", node);
      if (name === "datalist") add("native-datalist", node);
      if (name === "details" || name === "summary") add("native-disclosure", node);
      const type = attr(node, "type");
      if (type && literalValues(type.initializer).some((v) => NATIVE_TYPES.has(v))) add("native-input", type);
      const title = attr(node, "title");
      // <svg><title> is an element, not this attribute; an <iframe>'s title is its accessible name, not a tooltip.
      if (title && (dom || DOM_FORWARDING.has(name)) && name !== "iframe") add("title-tooltip", title);
      if (name === "form") {
        const nv = attr(node, "noValidate");
        const off = nv?.initializer && ts.isJsxExpression(nv.initializer) && nv.initializer.expression?.kind === ts.SyntaxKind.FalseKeyword;
        if (!nv || off) add("form-validate", node);
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && DIALOGS.has(callee.text) && !declared.has(callee.text)) add("native-dialog", node);
      if (ts.isPropertyAccessExpression(callee)) {
        const prop = callee.name.text;
        if (DIALOGS.has(prop) && ts.isIdentifier(callee.expression) && GLOBALS.has(callee.expression.text)) add("native-dialog", node);
        if (prop === "reportValidity" || prop === "setCustomValidity") add("native-validity", node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  leavePromptFindings(sf, add);
  return findings.sort((a, b) => a.line - b.line);
}

// A function that handles beforeunload: passed inline to addEventListener("beforeunload", ...), named and passed so,
// or typed (event: BeforeUnloadEvent).
function leavePromptFindings(sf, add) {
  const handlerNames = new Set();
  const inline = new Set();
  const isBeforeUnload = (n) => n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === "beforeunload";
  const collect = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "addEventListener" && isBeforeUnload(n.arguments[0])) {
      const h = n.arguments[1];
      if (h && ts.isIdentifier(h)) handlerNames.add(h.text);
      else if (h) inline.add(h);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const isHandler = (fn) => {
    if (inline.has(fn)) return true;
    if (ts.isFunctionDeclaration(fn) && fn.name && handlerNames.has(fn.name.text)) return true;
    if (fn.parent && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name) && handlerNames.has(fn.parent.name.text)) return true;
    return fn.parameters.some((p) => p.type && p.type.getText(sf) === "BeforeUnloadEvent");
  };
  const asks = (fn) => {
    let found = false;
    const look = (n) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "preventDefault") found = true;
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left) && n.left.name.text === "returnValue") found = true;
      if (!found) ts.forEachChild(n, look);
    };
    if (fn.body) look(fn.body);
    return found;
  };
  const visit = (n) => {
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)) && isHandler(n) && asks(n)) add("native-leave-prompt", n);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left) && n.left.name.text === "onbeforeunload") add("native-leave-prompt", n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?)$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** Findings for every source file under the given directories, relative to root: [{ file, rule, line, text }]. */
export function scanTree(root, dirs = ["src"]) {
  const findings = [];
  for (const d of dirs) {
    for (const file of walk(join(root, d), [])) {
      const rel = relative(root, file).split(sep).join("/");
      if (EXEMPT_DIRS.some((x) => rel.startsWith(`${x}/`))) continue;
      const own = scanSource(readFileSync(file, "utf8"), file);
      for (const allow of ALLOWED.filter((a) => a.file === rel)) {
        const hits = own.filter((f) => f.rule === allow.rule);
        // Exactly the kept number: more is a new use, fewer means the entry is stale.
        if (hits.length === allow.count) for (const h of hits) own.splice(own.indexOf(h), 1);
        else if (hits.length < allow.count) own.push({ rule: "stale-allowance", line: 1, text: `${allow.rule} expected ${allow.count}, found ${hits.length}` });
      }
      for (const f of own) findings.push({ file: rel, ...f });
    }
  }
  for (const allow of ALLOWED) {
    if (!dirs.some((d) => allow.file.startsWith(`${d}/`))) continue;
    try {
      statSync(join(root, allow.file));
    } catch {
      findings.push({ file: allow.file, rule: "stale-allowance", line: 1, text: "file not found" });
    }
  }
  return findings;
}

// Run as a script (not imported by the unit test). No import.meta: the unit test loads this file through Playwright's
// CommonJS transform. Run it from the repository root (npm and CI do).
if (process.argv[1]?.endsWith("check-native-controls.mjs")) {
  const root = process.cwd();
  const dirs = process.argv.slice(2);
  const findings = scanTree(root, dirs.length ? dirs : ["src"]);
  for (const f of findings) console.error(`${f.file}:${f.line}  ${f.rule}  ${RULES[f.rule]}\n    ${f.text}`);
  if (findings.length) {
    console.error(`\n${findings.length} native picker/popup finding(s). Guide: docs/evidence/day7/pickers.md`);
    process.exit(1);
  }
  console.log("No native pickers or popups in src/ (outside src/components/ui).");
}
