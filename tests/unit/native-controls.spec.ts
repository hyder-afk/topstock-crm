import path from "node:path";
import { expect, test } from "@playwright/test";
// A plain ES module script, also run by CI as `node scripts/check-native-controls.mjs`.
import { RULES, scanSource, scanTree } from "../../scripts/check-native-controls.mjs";

// Day 7b (Haider 15 Oct 2026: "do not keep any native pickers or popups on the app"): the source check that keeps them
// out. Each rule is shown firing on a planted break and staying quiet on its look-alikes, then the real src/ must be
// clean. CI also runs the script on its own in the quality job, so a finding fails both.

type Finding = { rule: string; line: number; text: string };
const rules = (code: string, file = "x.tsx") => (scanSource(code, file) as Finding[]).map((f) => f.rule);

test("every rule has a fix-it message", () => {
  expect(Object.keys(RULES).sort()).toEqual(
    ["form-validate", "native-datalist", "native-dialog", "native-disclosure", "native-input", "native-select", "native-validity", "title-tooltip"].sort(),
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

test("native-datalist: the browser's suggestion popup fails", () => {
  expect(rules(`const a = <datalist id="d"><option value="x" /></datalist>;`)).toEqual(["native-datalist"]);
});

test("title-tooltip: title= on HTML elements and DOM-forwarding components fails; a title prop on our own components does not", () => {
  expect(rules(`const a = <span title="x">y</span>;`)).toEqual(["title-tooltip"]);
  expect(rules(`const a = <time dateTime={d} title={full}>{rel}</time>;`)).toEqual(["title-tooltip"]);
  expect(rules(`const a = <Link href="/" title={t("k")}>y</Link>;`)).toEqual(["title-tooltip"]);
  expect(rules(`const a = <Button title="why">y</Button>;`)).toEqual(["title-tooltip"]);
  expect(rules(`const a = <motion.div title="x" />;`)).toEqual(["title-tooltip"]);
  expect(rules(`const a = <Card title={t("x")}>y</Card>;`)).toEqual([]);
  expect(rules(`const a = <ListState kind="empty" title={t("x")} />;`)).toEqual([]);
  expect(rules(`const a = <svg><title>Logo</title></svg>;`)).toEqual([]);
  expect(rules(`const a = <iframe title="Map" src="/m" />;`)).toEqual([]);
  expect(rules(`const a = <Tooltip content="x"><button aria-label="y" /></Tooltip>;`)).toEqual([]);
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

test("findings carry the line and the offending text", () => {
  const [f] = scanSource(`const a = 1;\nconst b = <select name="x" />;`, "x.tsx") as Finding[];
  expect(f).toEqual({ rule: "native-select", line: 2, text: `<select name="x" />` });
});

test("src/ has no native pickers or popups outside src/components/ui", () => {
  const findings = scanTree(path.join(__dirname, "..", ".."), ["src"]) as (Finding & { file: string })[];
  expect(findings.map((f) => `${f.file}:${f.line} ${f.rule} ${f.text}`)).toEqual([]);
});
