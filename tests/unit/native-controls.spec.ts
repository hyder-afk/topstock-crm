import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
// A plain ES module script, also run by CI as `node scripts/check-native-controls.mjs`.
import { ALLOWED, RULES, scanSource, scanTree, TITLE_PROP } from "../../scripts/check-native-controls.mjs";

// Day 7b (Haider 15 Oct 2026: "do not keep any native pickers or popups on the app"): the source check that keeps them
// out. Each rule is shown firing on a planted break and staying quiet on its look-alikes, then the real src/ must be
// clean. CI also runs the script on its own in the quality job, so a finding fails both.

type Finding = { rule: string; line: number; text: string };
const rules = (code: string, file = "x.tsx") => (scanSource(code, file) as Finding[]).map((f) => f.rule);

test("every rule has a fix-it message", () => {
  expect(Object.keys(RULES).sort()).toEqual(
    [
      "form-validate",
      "input-type-computed",
      "native-datalist",
      "native-dialog",
      "native-disclosure",
      "native-input",
      "native-leave-prompt",
      "native-select",
      "native-validity",
      "stale-allowance",
      "title-tooltip",
    ].sort(),
  );
});

test("native-select: a raw <select> fails; the app's Select does not", () => {
  expect(rules(`const a = <select name="x"><option>1</option></select>;`)).toEqual(["native-select"]);
  expect(rules(`const a = <Select name="x"><option>1</option></Select>;`)).toEqual([]);
});

test("native-input: date, time, datetime-local, month, week, color and search fail on any element, in any spelling", () => {
  for (const type of ["date", "time", "datetime-local", "month", "week", "color", "search"]) {
    expect(rules(`const a = <input type="${type}" />;`), type).toEqual(["native-input"]);
    expect(rules(`const a = <Input type={"${type}"} />;`), `Input ${type}`).toEqual(["native-input"]);
  }
  expect(rules(`const a = <input type={big ? "datetime-local" : "text"} />;`)).toEqual(["native-input"]);
  expect(rules(`const a = <input type={\`search\`} />;`)).toEqual(["native-input"]);
  for (const type of ["text", "email", "password", "number", "hidden", "file", "checkbox", "radio", "tel"]) {
    expect(rules(`const a = <input type="${type}" />;`), type).toEqual([]);
  }
  expect(rules(`const a = <button type="submit" />;`)).toEqual([]);
});

test("input-type-computed: a type on input/Input the check cannot read fails (it could be a native picker)", () => {
  expect(rules(`const a = <input type={kind} />;`)).toEqual(["input-type-computed"]);
  expect(rules(`const a = <Input type={props.type} />;`)).toEqual(["input-type-computed"]);
  expect(rules(`const a = <input type={pick()} />;`)).toEqual(["input-type-computed"]);
  expect(rules(`const a = <input type={\`\${base}\`} />;`)).toEqual(["input-type-computed"]);
  // Written in the code, so the check reads every value: literals and ternaries of literals.
  expect(rules(`const a = <input type={show ? "text" : "password"} />;`)).toEqual([]);
  expect(rules(`const a = <Input type={("email")} />;`)).toEqual([]);
  expect(rules(`const a = <input type={\`text\`} />;`)).toEqual([]);
  // Only input and Input: a button's type is never a picker.
  expect(rules(`const a = <button type={kind} />;`)).toEqual([]);
});

test("native-datalist: the browser's suggestion popup fails", () => {
  expect(rules(`const a = <datalist id="d"><option value="x" /></datalist>;`)).toEqual(["native-datalist"]);
});

test("title-tooltip: title= on HTML elements and on any component outside TITLE_PROP fails; a listed component's title prop does not", () => {
  expect(rules(`const a = <span title="x">y</span>;`)).toEqual(["title-tooltip"]);
  expect(rules(`const a = <time dateTime={d} title={full}>{rel}</time>;`)).toEqual(["title-tooltip"]);
  expect(rules(`const a = <Link href="/" title={t("k")}>y</Link>;`)).toEqual(["title-tooltip"]);
  expect(rules(`const a = <Button title="why">y</Button>;`)).toEqual(["title-tooltip"]);
  expect(rules(`const a = <motion.div title="x" />;`)).toEqual(["title-tooltip"]);
  // Fails closed: a component nobody listed may hand title to a DOM element.
  expect(rules(`const a = <Badge title="x">y</Badge>;`)).toEqual(["title-tooltip"]);
  expect(rules(`const a = <Menu.Item title="x" />;`)).toEqual(["title-tooltip"]);
  expect(rules(`const a = <Input title="x" />;`)).toEqual(["title-tooltip"]);
  expect(rules(`const a = <Card title={t("x")}>y</Card>;`)).toEqual([]);
  expect(rules(`const a = <ListState kind="empty" title={t("x")} />;`)).toEqual([]);
  expect(rules(`const a = <svg><title>Logo</title></svg>;`)).toEqual([]);
  expect(rules(`const a = <iframe title="Map" src="/m" />;`)).toEqual([]);
  expect(rules(`const a = <Tooltip content="x"><button aria-label="y" /></Tooltip>;`)).toEqual([]);
  for (const name of TITLE_PROP) expect(rules(`const a = <${name} title="x" />;`), name).toEqual([]);
});

test("TITLE_PROP lists exactly the components with a title prop of their own", () => {
  expect([...TITLE_PROP].sort()).toEqual(
    [
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
    ].sort(),
  );
});

test("native-disclosure: raw <details> and <summary> fail; Disclosure does not", () => {
  expect(rules(`const a = <details><summary>x</summary>y</details>;`)).toEqual(["native-disclosure", "native-disclosure"]);
  expect(rules(`const a = <Disclosure summary="x">y</Disclosure>;`)).toEqual([]);
});

test("native-dialog: window.confirm, alert and prompt fail, bare or through a global; a local function of that name does not", () => {
  expect(rules(`if (window.confirm("Delete?")) go();`, "x.ts")).toEqual(["native-dialog"]);
  expect(rules(`globalThis.alert("x");`, "x.ts")).toEqual(["native-dialog"]);
  expect(rules(`self.prompt("x");`, "x.ts")).toEqual(["native-dialog"]);
  expect(rules(`alert("x");`, "x.ts")).toEqual(["native-dialog"]);
  expect(rules(`const ok = confirm("x");`, "x.ts")).toEqual(["native-dialog"]);
  expect(rules(`function confirm() {} confirm();`, "x.ts")).toEqual([]);
  expect(rules(`const confirm = () => 1; confirm();`, "x.ts")).toEqual([]);
  expect(rules(`function f({ confirm }: { confirm: () => void }) { confirm(); }`, "x.ts")).toEqual([]);
  expect(rules(`dialog.confirm(); store.alert();`, "x.ts")).toEqual([]);
});

test("native-dialog is scope-aware: a confirm declared in one function does not cover the global one called in another", () => {
  // File-wide, the local `confirm` in a() hid b()'s call to the browser's; by scope it is found.
  expect(rules(`function a() { const confirm = () => 1; confirm(); }\nfunction b() { confirm("Delete?"); }`, "x.ts")).toEqual(["native-dialog"]);
  expect(rules(`if (x) { const alert = show; alert(); } alert("x");`, "x.ts")).toEqual(["native-dialog"]);
  // The global reached other ways: element access, destructuring, passed on as a value.
  expect(rules(`window["alert"]("x");`, "x.ts")).toEqual(["native-dialog"]);
  expect(rules(`const { confirm } = window; confirm("x");`, "x.ts")).toEqual(["native-dialog"]);
  expect(rules(`const { prompt: ask } = globalThis;`, "x.ts")).toEqual(["native-dialog"]);
  expect(rules(`setTimeout(alert, 0);`, "x.ts")).toEqual(["native-dialog"]);
  expect(rules(`const a = <button onClick={() => top.confirm("x")} />;`)).toEqual(["native-dialog"]);
  // Declared in an enclosing scope: parameters, a catch variable, a hoisted var, an import, a shadowed window.
  expect(rules(`function f(confirm: () => void) { return () => confirm(); }`, "x.ts")).toEqual([]);
  expect(rules(`try { go(); } catch (alert) { alert(); }`, "x.ts")).toEqual([]);
  expect(rules(`function f() { if (x) { var prompt = ask; } prompt(); }`, "x.ts")).toEqual([]);
  expect(rules(`import { confirm } from "./dialogs"; confirm("x");`, "x.ts")).toEqual([]);
  expect(rules(`function f(window: { confirm(): void }) { window.confirm(); }`, "x.ts")).toEqual([]);
  // Property names are not references.
  expect(rules(`const o = { confirm: 1, alert() {} }; o.alert();`, "x.ts")).toEqual([]);
});

test("form-validate: a <form> without noValidate (or with noValidate={false}) fails", () => {
  expect(rules(`const a = <form onSubmit={(e) => e.preventDefault()}><input required /></form>;`)).toEqual(["form-validate"]);
  expect(rules(`const a = <form noValidate={false} />;`)).toEqual(["form-validate"]);
  expect(rules(`const a = <form noValidate onSubmit={(e) => e.preventDefault()} />;`)).toEqual([]);
  expect(rules(`const a = <form noValidate={true} action={act} />;`)).toEqual([]);
});

test("native-validity: reportValidity and setCustomValidity fail", () => {
  expect(rules(`input.setCustomValidity("x"); form.reportValidity();`, "x.ts")).toEqual(["native-validity", "native-validity"]);
  expect(rules(`form.checkValidity();`, "x.ts")).toEqual([]);
});

test("native-leave-prompt: preventDefault or returnValue in a beforeunload handler, and onbeforeunload=, fail; a beacon on beforeunload does not", () => {
  expect(rules(`const h = (e: BeforeUnloadEvent) => e.preventDefault(); window.addEventListener("beforeunload", h);`, "x.ts")).toEqual(["native-leave-prompt"]);
  expect(rules(`window.addEventListener("beforeunload", (e) => { e.returnValue = ""; });`, "x.ts")).toEqual(["native-leave-prompt"]);
  expect(rules(`function h(e) { e.preventDefault(); } window.addEventListener("beforeunload", h);`, "x.ts")).toEqual(["native-leave-prompt"]);
  expect(rules(`window.onbeforeunload = () => "Leave?";`, "x.ts")).toEqual(["native-leave-prompt"]);
  expect(rules(`function f(e: BeforeUnloadEvent) { e.preventDefault(); }`, "x.ts")).toEqual(["native-leave-prompt"]);
  // The queue's goodbye beacon listens to beforeunload but never asks; other preventDefault calls are not the prompt.
  expect(rules(`const h = () => navigator.sendBeacon("/r"); window.addEventListener("beforeunload", h);`, "x.ts")).toEqual([]);
  expect(rules(`form.addEventListener("submit", (e) => e.preventDefault()); window.addEventListener("pagehide", (e) => e.preventDefault());`, "x.ts")).toEqual([]);
});

test("ALLOWED holds exactly one kept use (the lead import's Leave site? prompt); a second one there, or none, fails", () => {
  expect(ALLOWED).toEqual([{ file: "src/components/import/import-workspace.tsx", rule: "native-leave-prompt", count: 1 }]);
  const one = `useEffect(() => { const h = (e: BeforeUnloadEvent) => e.preventDefault(); window.addEventListener("beforeunload", h); });`;
  const root = mkdtempSync(path.join(os.tmpdir(), "native-allow-"));
  try {
    const file = path.join(root, "src/components/import/import-workspace.tsx");
    mkdirSync(path.dirname(file), { recursive: true });
    const run = (code: string) => {
      writeFileSync(file, code);
      return (scanTree(root, ["src"]) as (Finding & { file: string })[]).map((f) => `${f.file} ${f.rule}`);
    };
    expect(run(one)).toEqual([]);
    expect(run(`${one}\n${one}`)).toEqual([
      "src/components/import/import-workspace.tsx native-leave-prompt",
      "src/components/import/import-workspace.tsx native-leave-prompt",
    ]);
    expect(run(`export const x = 1;`)).toEqual(["src/components/import/import-workspace.tsx stale-allowance"]);
    // The same prompt in any other file is not covered.
    writeFileSync(file, one);
    writeFileSync(path.join(root, "src/other.tsx"), one);
    expect((scanTree(root, ["src"]) as (Finding & { file: string })[]).map((f) => `${f.file} ${f.rule}`)).toEqual(["src/other.tsx native-leave-prompt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findings carry the line and the offending text", () => {
  const [f] = scanSource(`const a = 1;\nconst b = <select name="x" />;`, "x.tsx") as Finding[];
  expect(f).toEqual({ rule: "native-select", line: 2, text: `<select name="x" />` });
});

test("src/ has no native pickers or popups outside src/components/ui", () => {
  const findings = scanTree(path.join(__dirname, "..", ".."), ["src"]) as (Finding & { file: string })[];
  expect(findings.map((f) => `${f.file}:${f.line} ${f.rule} ${f.text}`)).toEqual([]);
});
