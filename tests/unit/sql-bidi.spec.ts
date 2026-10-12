import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// No raw bidirectional control character in any SQL file ("Trojan Source": a hidden U+202A-202E or U+2066-2069 can make
// a line display in a different order than it runs, and GitHub flags the file). Regexes that refuse these characters
// write them as escapes ('‪-‮⁦-⁩'), as every merged migration does (Day 5a verifier finding 5).
const root = join(__dirname, "../../supabase");
const files = ["migrations", "tests"].flatMap((d) =>
  readdirSync(join(root, d))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => join(d, f)),
);

// Built from code points so this file holds none of them either.
const BIDI = new RegExp(
  `[${[0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c]
    .map((c) => String.fromCharCode(c))
    .join("")}]`,
  "g",
);

test("there are SQL files to check", () => {
  expect(files.length).toBeGreaterThan(10);
  expect(files).toContain(join("migrations", "20261015090000_deals_pipeline.sql"));
});

for (const file of files) {
  test(`${file}: no raw bidirectional control characters`, () => {
    const lines = readFileSync(join(root, file), "utf8").split("\n");
    const hits = lines.flatMap((l, i) => (l.match(BIDI) ? [i + 1] : []));
    expect(hits, `raw bidi characters in ${file} on lines`).toEqual([]);
  });
}

test("the check itself: a raw override is caught, the escape passes", () => {
  expect(`x ~ '[${String.fromCharCode(0x202e)}]'`.match(BIDI)).not.toBeNull();
  expect("x ~ '[\\u202A-\\u202E\\u2066-\\u2069]'".match(BIDI)).toBeNull();
});
