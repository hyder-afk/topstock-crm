import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import ts from "typescript";

// Day 7c French pass: words people read come from messages/en.json and messages/fr.json, never from the source. This
// walks every .tsx file in src/ and reports JSX text with letters (or French punctuation) and the string literals of an
// attribute people read or hear (aria-label, placeholder, alt, title, label) or of a JSX child, including those in the
// branches of a conditional (a ? "x" : "y") and the operands of || and ?? (t("a") || "x"). The few exceptions are
// named below. Not scanned: .ts files (helpers that build text are reviewed by hand, and their words go through
// next-intl at the call site) and the arguments of toast() and other function calls.

const SRC = path.join(__dirname, "..", "..", "src");
const READ_ATTRS = new Set(["aria-label", "aria-description", "aria-roledescription", "aria-valuetext", "aria-placeholder", "placeholder", "alt", "title", "label"]);

type Finding = { file: string; kind: string; text: string };

// file + text, so a moved line keeps its exception and a new string in the same file does not inherit it.
const ALLOWED = new Set([
  // The root layout's last-resort boundary: translations may be unavailable there, so it says both.
  "app/global-error.tsx|Something went wrong /",
  "app/global-error.tsx|Une erreur est survenue",
  "app/global-error.tsx|Try again /",
  "app/global-error.tsx|Réessayer",
  // The brand name of the logo.
  "components/logo.tsx|TopStock",
  // The command menu's language switch, each language named in itself.
  "components/shell/command-palette.tsx|English",
  "components/shell/command-palette.tsx|Français",
]);

// The string literals an expression can evaluate to: itself, the branches of a conditional, the operands of || and ??
// (through parentheses). Calls, template literals with values and other expressions are left out.
function literals(expr: ts.Expression): string[] {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [expr.text];
  if (ts.isParenthesizedExpression(expr)) return literals(expr.expression);
  if (ts.isConditionalExpression(expr)) return [...literals(expr.whenTrue), ...literals(expr.whenFalse)];
  if (ts.isBinaryExpression(expr) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(expr.operatorToken.kind)) {
    return [...literals(expr.left), ...literals(expr.right)];
  }
  return [];
}

function scan(code: string, file: string): Finding[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: Finding[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      const text = node.text.trim();
      if (/[A-Za-zÀ-ÿ]{2,}|[:;?!«»]/.test(text)) found.push({ file, kind: "text", text });
    }
    if (ts.isJsxAttribute(node) && node.initializer && READ_ATTRS.has(node.name.getText(source))) {
      const init = node.initializer;
      const kind = node.name.getText(source);
      for (const text of ts.isStringLiteral(init) ? [init.text] : ts.isJsxExpression(init) && init.expression ? literals(init.expression) : []) {
        if (/[A-Za-zÀ-ÿ]{2,}/.test(text)) found.push({ file, kind, text });
      }
    }
    if (ts.isJsxExpression(node) && node.expression && node.parent && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      for (const text of literals(node.expression)) if (/[A-Za-zÀ-ÿ]{2,}/.test(text)) found.push({ file, kind: "text", text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(full);
    return entry.name.endsWith(".tsx") ? [full] : [];
  });
}

test("the scan finds text, read attributes and string children, and leaves code alone", () => {
  const kinds = (code: string) => scan(code, "x.tsx").map((f) => `${f.kind}:${f.text}`);
  expect(kinds(`const a = <p>Save changes</p>;`)).toEqual(["text:Save changes"]);
  expect(kinds(`const a = <p>{t("save")} :</p>;`)).toEqual(["text::"]);
  expect(kinds(`const a = <input placeholder="Search leads" aria-label={"Search"} />;`)).toEqual(["placeholder:Search leads", "aria-label:Search"]);
  expect(kinds(`const a = <p>{"Hello"}</p>;`)).toEqual(["text:Hello"]);
  expect(kinds(`const a = <p className="flex gap-2" data-x="abc">{t("ok")} · {n}</p>;`)).toEqual([]);
  expect(kinds(`const a = <img alt="" />;`)).toEqual([]);
  // Literals hidden in a conditional or a fallback, in an attribute and as a child.
  expect(kinds(`const a = <b title={on ? "Open" : t("closed")} />;`)).toEqual(["title:Open"]);
  expect(kinds(`const a = <b aria-label={name ?? (x || "Untitled")} />;`)).toEqual(["aria-label:Untitled"]);
  expect(kinds(`const a = <p>{done ? t("done") : "Pending"}</p>;`)).toEqual(["text:Pending"]);
  expect(kinds(`const a = <p>{name || "Unknown"}</p>;`)).toEqual(["text:Unknown"]);
  expect(kinds(`const a = <p>{cn("flex gap-2")}{count > 1 ? n : null}</p>;`)).toEqual([]);
});

test("no words in src/ bypass next-intl (outside the named exceptions)", () => {
  const found = tsxFiles(SRC).flatMap((file) => scan(readFileSync(file, "utf8"), path.relative(SRC, file).split(path.sep).join("/")));
  const keys = found.map((f) => `${f.file}|${f.text}`);
  expect(found.filter((_, i) => !ALLOWED.has(keys[i]))).toEqual([]);
  // Every exception still matches something, so the list cannot grow stale.
  expect([...ALLOWED].filter((key) => !keys.includes(key))).toEqual([]);
});
