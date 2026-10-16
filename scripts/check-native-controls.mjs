#!/usr/bin/env node
// Day 7b source check (Haider 15 Oct 2026: "do not keep any native pickers or popups on the app"). Fails when any of
// these come back in src/ outside src/components/ui (where the app's own pickers live):
//   native-select     a raw <select> (use Select or Combobox from @/components/ui)
//   native-input      type="date" | "time" | "datetime-local" | "month" | "week" | "color" | "search" on any element
//                     (use DatePicker, TimePicker, DateTimePicker, SearchInput)
//   native-datalist   <datalist> (the browser's suggestion popup; use Combobox)
//   title-tooltip     title= on an HTML element, or on any component not in TITLE_PROP (components whose own `title`
//                     prop is a heading, never the attribute); fails closed: a new component needs an entry there
//                     (use Tooltip on focusable things, visible or screen-reader text elsewhere)
//   input-type-computed a `type` on input/Input that is not a literal (or a ternary of literals): the check cannot
//                     read it, so it cannot prove it is not a native picker
//   native-disclosure a raw <details>/<summary> (use Disclosure: our own chevron, no browser triangle)
//   native-dialog     confirm / alert / prompt that resolve to the browser's: bare where no enclosing scope declares
//                     that name, or through window/globalThis/self/top/parent/frames (dot, ["..."] or destructuring)
//                     (use the app's Dialog)
//   form-validate     a <form> without noValidate (errors go in FormMessage, never the browser's bubble)
//   native-validity   reportValidity() / setCustomValidity() (the bubble, called by hand)
//   native-leave-prompt the browser's "Leave site?" prompt: preventDefault() or returnValue= in a beforeunload
//                     handler, or any onbeforeunload= (ALLOWED below holds the one use kept, see its comment)
// It reads the code with the TypeScript parser (no regex on JSX), so a listed component's `title` prop (Card, ListState)
// or a `confirm` declared in an enclosing scope is not a finding. Run: node scripts/check-native-controls.mjs [dir ...]
// The rules are unit-tested in tests/unit/native-controls.spec.ts, which also runs this check over src/.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

const NATIVE_TYPES = new Set(["date", "time", "datetime-local", "month", "week", "color", "search"]);
// Components with a `title` prop of their own (a heading or label they draw as text, never the title attribute). title=
// on any other capitalised component fails (it may hand it to a DOM element: Link, Button, Input, ...). Checked against
// src/ on 16 Oct 2026: these 15 are every component given title= outside src/components/ui.
export const TITLE_PROP = new Set([
  "AttentionCard",
  "AuthCard",
  "Card",
  "Column",
  "DealRows",
  "EmptyState",
  "HomeCard",
  "ListState",
  "OpenDealSwitch",
  "PipelineSnapshot",
  "ReasonList",
  "RecentActivity",
  "Section",
  "StatePanel",
  "ValueSection",
]);
const DIALOGS = new Set(["confirm", "alert", "prompt"]);
// The global object under its names: window.confirm, self["alert"], const { prompt } = globalThis.
const GLOBALS = new Set(["window", "globalThis", "self", "top", "parent", "frames"]);
// The app's own components may wrap the native elements they replace.
const EXEMPT_DIRS = [["src", "components", "ui"].join("/")];

export const RULES = {
  "native-select": "a raw <select>: use Select (or Combobox for long lists) from @/components/ui",
  "native-input": "a native date/time/search input: use DatePicker, TimePicker, DateTimePicker or SearchInput",
  "input-type-computed": "a computed type on input/Input: write it as a literal (or a ternary of literals) so the check can read it",
  "native-datalist": "a <datalist> suggestion popup: use Combobox",
  "title-tooltip": "title= shows the browser's tooltip: use Tooltip on a focusable element, or visible / sr-only text (a component with its own title prop goes in TITLE_PROP)",
  "native-disclosure": "a raw <details>/<summary>: use Disclosure from @/components/ui/disclosure",
  "native-dialog": "window.confirm/alert/prompt: use the app's Dialog",
  "form-validate": "a <form> without noValidate: add noValidate and show errors in FormMessage",
  "native-validity": "reportValidity/setCustomValidity shows the browser's bubble: use FormMessage",
  "native-leave-prompt": "the browser's \"Leave site?\" prompt: keep the work safe in the app instead (only ALLOWED may ask)",
  "stale-allowance": "an ALLOWED native use is gone or moved: update ALLOWED in scripts/check-native-controls.mjs",
};

// The native uses kept on purpose, each exactly once. Anything more in that file, or the same use anywhere else, fails.
export const ALLOWED = [
  {
    file: "src/components/import/import-workspace.tsx",
    rule: "native-leave-prompt",
    // Builder's decision, taken under Haider's standing instruction (15 Oct 2026, docs/log.md); Haider to confirm.
    // While a lead import is sending or importing rows, the browser asks "Leave site?" before the tab closes or
    // reloads. No page can replace it: once the tab is closing, only the browser can still ask, and closing would
    // pause the import.
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

// True when every value the attribute can take is written in the code: "x", {"x"}, {`x`}, or a ternary (or brackets)
// of those. An identifier, a call or a template with ${} is computed: the check cannot read it.
function isStaticString(init) {
  if (!init) return true; // <input type /> (no value): not a picker
  if (ts.isStringLiteral(init)) return true;
  if (!ts.isJsxExpression(init) || !init.expression) return false;
  const ok = (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return true;
    if (ts.isParenthesizedExpression(n)) return ok(n.expression);
    if (ts.isConditionalExpression(n)) return ok(n.whenTrue) && ok(n.whenFalse);
    return false;
  };
  return ok(init.expression);
}

// --- Scope: does a name resolve to something the file declares, or to the browser's global? ---------------------------

function bindingNames(name, out) {
  if (!name) return;
  if (ts.isIdentifier(name)) out.add(name.text);
  else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
  }
}

// `var` declarations anywhere in a function body (hoisted), not inside nested functions.
function hoistedVars(body, out) {
  const visit = (n) => {
    if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
    if (ts.isVariableDeclarationList(n) && !(n.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))) {
      for (const d of n.declarations) bindingNames(d.name, out);
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(body, visit);
}

function statementNames(statements, out) {
  for (const st of statements) {
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) bindingNames(d.name, out);
    else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) out.add(st.name.text);
    else if (ts.isImportDeclaration(st) && st.importClause) {
      const c = st.importClause;
      if (c.name) out.add(c.name.text);
      const nb = c.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) out.add(nb.name.text);
      else if (nb) for (const el of nb.elements) out.add(el.name.text);
    } else if (ts.isImportEqualsDeclaration(st)) out.add(st.name.text);
  }
}

// The names a scope node declares for the code inside it.
const scopeCache = new WeakMap();
function scopeNames(node) {
  if (scopeCache.has(node)) return scopeCache.get(node);
  const out = new Set();
  if (ts.isSourceFile(node)) {
    statementNames(node.statements, out);
    hoistedVars(node, out);
  } else if (ts.isFunctionLike(node)) {
    for (const p of node.parameters ?? []) bindingNames(p.name, out);
    if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) out.add(node.name.text);
    if (node.body) hoistedVars(node.body, out);
  } else if (ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
    statementNames(node.statements, out);
  } else if ((ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) && node.initializer && ts.isVariableDeclarationList(node.initializer)) {
    for (const d of node.initializer.declarations) bindingNames(d.name, out);
  } else if (ts.isCatchClause(node) && node.variableDeclaration) {
    bindingNames(node.variableDeclaration.name, out);
  } else if (ts.isClassExpression(node) && node.name) out.add(node.name.text);
  scopeCache.set(node, out);
  return out;
}

/** True when `id` refers to the browser's global of that name: no enclosing scope declares it. */
function isGlobalRef(id) {
  for (let n = id.parent; n; n = n.parent) if (scopeNames(n).has(id.text)) return false;
  return true;
}

// An identifier read as a value (called, passed, assigned, put in JSX), not a property name or a declaration.
function isValueUse(id) {
  const p = id.parent;
  if (!p) return false;
  if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && (p.expression === id || p.arguments?.includes(id))) return true;
  if (ts.isTaggedTemplateExpression(p) && p.tag === id) return true;
  if (ts.isVariableDeclaration(p) && p.initializer === id) return true;
  if (ts.isBinaryExpression(p) && p.right === id) return true;
  if (ts.isJsxExpression(p) || ts.isShorthandPropertyAssignment(p) || ts.isReturnStatement(p) || ts.isArrayLiteralExpression(p)) return true;
  if (ts.isPropertyAssignment(p) && p.initializer === id) return true;
  if (ts.isParenthesizedExpression(p) || (ts.isConditionalExpression(p) && p.condition !== id)) return true;
  return false;
}

const isGlobalObject = (n) => n && ts.isIdentifier(n) && GLOBALS.has(n.text) && isGlobalRef(n);
const stringKey = (n) => n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;

/** Findings for one file's source text: [{ rule, line, text }]. */
export function scanSource(text, fileName = "file.tsx") {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : fileName.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
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
      if (type && (name === "input" || name === "Input") && !isStaticString(type.initializer)) add("input-type-computed", type);
      const title = attr(node, "title");
      // <svg><title> is an element, not this attribute; an <iframe>'s title is its accessible name, not a tooltip. Any
      // capitalised component fails unless it is listed in TITLE_PROP (fails closed).
      if (title && name !== "iframe" && (dom || !TITLE_PROP.has(name))) add("title-tooltip", title);
      if (name === "form") {
        const nv = attr(node, "noValidate");
        const off = nv?.initializer && ts.isJsxExpression(nv.initializer) && nv.initializer.expression?.kind === ts.SyntaxKind.FalseKeyword;
        if (!nv || off) add("form-validate", node);
      }
    }
    // confirm/alert/prompt that resolve to the browser's: a bare name no enclosing scope declares (called, or passed on
    // as a value), window.confirm, self["alert"], or taken out of the global object by destructuring.
    if (ts.isIdentifier(node) && DIALOGS.has(node.text) && isValueUse(node) && isGlobalRef(node)) add("native-dialog", node.parent);
    if (ts.isPropertyAccessExpression(node) && DIALOGS.has(node.name.text) && isGlobalObject(node.expression)) add("native-dialog", node);
    if (ts.isElementAccessExpression(node) && DIALOGS.has(stringKey(node.argumentExpression) ?? "") && isGlobalObject(node.expression)) add("native-dialog", node);
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && isGlobalObject(node.initializer)) {
      for (const el of node.name.elements) {
        const key = el.propertyName ? (ts.isIdentifier(el.propertyName) ? el.propertyName.text : stringKey(el.propertyName)) : ts.isIdentifier(el.name) ? el.name.text : null;
        if (key && DIALOGS.has(key)) add("native-dialog", el);
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const prop = node.expression.name.text;
      if (prop === "reportValidity" || prop === "setCustomValidity") add("native-validity", node);
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
