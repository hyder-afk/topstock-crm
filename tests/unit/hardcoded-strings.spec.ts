import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import ts from "typescript";

// Day 7c French pass: words people read come from messages/en.json and messages/fr.json, never from the source. This
// walks every .tsx file in src/ and reports JSX text with letters (or French punctuation) and the literal value of an
// attribute people read or hear (aria-label, placeholder, alt, title, label). The few exceptions are named below.

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
  // A country code as the example in the ship-to field.
  "components/sales/record-sale-sheet.tsx|FR",
  // Each language named in its own language, so a person finds theirs whatever the interface says.
  "components/share-links/link-card.tsx|Français",
  "components/share-links/link-card.tsx|English",
  // Not text: the skeleton card's test hook ("label" prop of CardSkeleton).
  "components/home/home-skeleton.tsx|recent",
  "components/home/home-skeleton.tsx|low-stock",
]);

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
      const literal = ts.isStringLiteral(init)
        ? init
        : ts.isJsxExpression(init) && init.expression && (ts.isStringLiteral(init.expression) || ts.isNoSubstitutionTemplateLiteral(init.expression))
          ? init.expression
          : null;
      if (literal && /[A-Za-zÀ-ÿ]{2,}/.test(literal.text)) found.push({ file, kind: node.name.getText(source), text: literal.text });
    }
    if (ts.isJsxExpression(node) && node.expression && ts.isStringLiteral(node.expression) && node.parent && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      if (/[A-Za-zÀ-ÿ]{2,}/.test(node.expression.text)) found.push({ file, kind: "text", text: node.expression.text });
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
});

test("no words in src/ bypass next-intl (outside the named exceptions)", () => {
  const found = tsxFiles(SRC).flatMap((file) => scan(readFileSync(file, "utf8"), path.relative(SRC, file).split(path.sep).join("/")));
  const keys = found.map((f) => `${f.file}|${f.text}`);
  expect(found.filter((_, i) => !ALLOWED.has(keys[i]))).toEqual([]);
  // Every exception still matches something, so the list cannot grow stale.
  expect([...ALLOWED].filter((key) => !keys.includes(key))).toEqual([]);
});
