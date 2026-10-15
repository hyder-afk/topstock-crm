// Usage: node eq-js.mjs <base commit> <rewrite commit>   (run from the repo root)
// Throwaway: compares every changed JS/TS regex literal (HEAD vs working tree) over all code points 0..0x10FFFF,
// and every changed string literal by value.
import { execSync } from "node:child_process";
const files = ["src/lib/inventory/schemas.ts","src/lib/sales/schemas.ts","src/lib/share/schema.ts","scripts/make-fake-stock.mjs",
  "tests/unit/inventory.spec.ts","tests/unit/sales.spec.ts","tests/unit/share.spec.ts","tests/unit/stock-normalise.spec.ts",
  "tests/unit/stock-schema.spec.ts","tests/auth/stock-import.spec.ts"];
const RX = /\/\^?\[[^\]\n]*\]\*?\$?\/[gimsuy]*|\/\^(?:[^\/ ]|\\u[0-9A-F]{4})\/[gimsuy]*/g;   // regex literals with a class, or /^X/
const STR = /String\.fromCodePoint\(0x[0-9a-f]+\)|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\\n]|\\.|\$\{[^}]*\})*`/g;
let regexPairs = 0, stringPairs = 0, fail = 0;
for (const f of files) {
  const diff = execSync(`git diff -U0 ${process.argv[2]} ${process.argv[3]} -- ${f}`, { encoding: "utf8" }).split("\n");
  const olds = diff.filter((l) => l.startsWith("-") && !l.startsWith("---")).map((l) => l.slice(1));
  const news = diff.filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
  if (olds.length !== news.length) throw new Error(`${f}: uneven hunk`);
  olds.forEach((o, i) => {
    const n = news[i];
    const ro = o.match(RX) ?? [], rn = n.match(RX) ?? [];
    if (ro.length !== rn.length) throw new Error(`${f}: regex count differs`);
    ro.forEach((lit, k) => {
      if (lit === rn[k]) return;
      const mk = (s) => { const j = s.lastIndexOf("/"); return new RegExp(s.slice(1, j), s.slice(j + 1).replace("g", "")); };
      const a = mk(lit), b = mk(rn[k]); let diffs = 0, hits = 0;
      for (let cp = 0; cp <= 0x10ffff; cp++) {
        const s = String.fromCodePoint(cp);
        const x = a.test(s), y = b.test(s); if (x) hits++; if (x !== y) diffs++;
      }
      // also as part of a longer string (anchors ^...$ and *)
      for (const cp of [0x41, 0x202e, 0xfeff, 0x200b, 0x0a, 0x09]) {
        const s = "ab" + String.fromCodePoint(cp) + "cd"; if (a.test(s) !== b.test(s)) diffs++;
      }
      regexPairs++; if (diffs) fail++;
      console.log(`${f}:${i}: regex ${diffs ? "DIFFERS (" + diffs + ")" : "same over 0..0x10FFFF"} (${hits} single code points match)`);
    });
    const so = (o.match(STR) ?? []).filter((s) => !(n.match(STR) ?? []).includes(s));
    const sn = (n.match(STR) ?? []).filter((s) => !(o.match(STR) ?? []).includes(s));
    if (so.length !== sn.length) throw new Error(`${f}: string count differs ${so} ${sn}`);
    so.forEach((s, k) => {
      const ev = (e) => Function("return " + e)();
      const same = ev(s) === ev(sn[k]); stringPairs++; if (!same) fail++;
      console.log(`${f}:${i}: string ${same ? "same value" : "DIFFERS"} (${[...ev(sn[k])].map((c) => c.codePointAt(0) > 0x7e ? "U+" + c.codePointAt(0).toString(16).toUpperCase() : c).join("")})`);
    });
  });
}
console.log(`regex pairs ${regexPairs}, string pairs ${stringPairs}, differences ${fail}`);
process.exit(fail ? 1 : 0);
