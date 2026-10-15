import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { expect, test } from "@playwright/test";

// No raw bidirectional control character in any source file ("Trojan Source": a hidden U+202A to U+202E or U+2066 to
// U+2069 can make a line display in a different order than it runs, and GitHub flags the file). Code that refuses these
// characters writes them as escapes (the text \u202A-\u202E\u2066-\u2069 in a SQL regex), as every merged migration does
// (Day 5a verifier finding 5). Since verifier round 2 (N3) this covers every source, test, script, message and document
// file, this spec included, not only the SQL files. Out of scope by extension: fake data files (.csv), where the import
// tests plant a right-to-left override on purpose (tests/fixtures/import/leads-500-fake.csv).
const repo = join(__dirname, "../..");
const ROOTS = ["src", "tests", "scripts", "supabase", "docs", "messages", ".github", ".claude"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "test-results", "playwright-report", ".temp", "__pycache__"]);
const EXTS = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".sql", ".sh", ".py", ".json", ".md", ".yml", ".yaml", ".css", ".toml",
]);

function walk(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : walk(path);
    return e.isFile() && EXTS.has(extname(e.name)) ? [path] : [];
  });
}

const files = [
  ...ROOTS.flatMap((r) => walk(join(repo, r))),
  ...readdirSync(repo, { withFileTypes: true })
    .filter((e) => e.isFile() && EXTS.has(extname(e.name)))
    .map((e) => join(repo, e.name)),
].map((f) => relative(repo, f));

// Built from code points so this file holds none of them either.
const BIDI = new RegExp(
  `[${[0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c]
    .map((c) => String.fromCharCode(c))
    .join("")}]`,
  "g",
);

test("there are files to check, this spec and the SQL among them", () => {
  expect(files.length).toBeGreaterThan(100);
  expect(files).toContain(join("supabase", "migrations", "20261015090000_deals_pipeline.sql"));
  expect(files).toContain(join("tests", "unit", "sql-bidi.spec.ts"));
  expect(files).toContain(join("messages", "fr.json"));
  expect(files.filter((f) => f.endsWith(".csv"))).toEqual([]);
});

test("no raw bidirectional control characters in any source file", () => {
  const hits = files.flatMap((file) =>
    readFileSync(join(repo, file), "utf8")
      .split("\n")
      .flatMap((l, i) => (l.match(BIDI) ? [`${file}:${i + 1}`] : [])),
  );
  expect(hits, "raw bidi characters (file:line)").toEqual([]);
});

test("the check itself: a raw override is caught, the escape passes", () => {
  expect(`x ~ '[${String.fromCharCode(0x202e)}]'`.match(BIDI)).not.toBeNull();
  expect("x ~ '[\\u202A-\\u202E\\u2066-\\u2069]'".match(BIDI)).toBeNull();
});
