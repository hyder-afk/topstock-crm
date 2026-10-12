#!/usr/bin/env node
// Fake stock sheets for the stock import tests (design docs/evidence/day6/design.md, section 7.10).
//
// Deterministic: a seeded PRNG (mulberry32), no clock and no Math.random, so every run writes byte-identical files.
// Fake data only: invented products and numbers. Only the header row is Haider's real one; the real sheet never enters
// a session.
//
//   node scripts/make-fake-stock.mjs                               writes tests/fixtures/stock/ (committed)
//   node scripts/make-fake-stock.mjs --rows 5000 --out /tmp/perf   one large, fully importable sheet (never committed)
//   node scripts/make-fake-stock.mjs --check                       exits 1 if the committed fixtures differ from the output
//   options: --seed N (default 20261018)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "stock");
const DEFAULT_SEED = 20261018;
// Haider's header row, exactly (11 Oct 2026).
const HEADER = [
  "CATÉGORIE",
  "PRIX PAR PCS MAX (SELLING PRICE IN EURO MAX)",
  "PRIX PAR PCS (SELLING PRICE IN EURO MIN)",
  "QUANTITÉ",
  "QTY PAR CARTON",
  "PP",
  "REVENTE MIN",
  "REVENTE MAX",
  "STATUS",
];
const BOM = "﻿";
const NBSP = " ";
const NNBSP = " ";

// ---------- deterministic randomness ----------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRandom(seed) {
  const next = mulberry32(seed);
  const int = (n) => Math.floor(next() * n);
  return { int, pick: (list) => list[int(list.length)], range: (lo, hi) => lo + next() * (hi - lo) };
}

// ---------- numbers in cents (no float drift) ----------

const toCents = (euros) => Math.round(euros * 100);
/** French money text: "1 234,56" with a NBSP between thousands (as Excel writes it). */
function fr(cents, sep = NBSP) {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const int = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  return `${neg ? "-" : ""}${int},${String(abs % 100).padStart(2, "0")}`;
}
function en(cents) {
  const int = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${int}.${String(cents % 100).padStart(2, "0")}`;
}

// ---------- invented products ----------

const ITEMS = [
  "Gobelet inox", "Bougie parfumée", "Torchon lin", "Carnet kraft", "Lampe frontale", "Gourde alu", "Tapis yoga",
  "Bol céramique", "Coussin velours", "Plaid polaire", "Serviette éponge", "Sac cabas", "Boîte hermétique",
  "Cuillère bois", "Panier osier", "Miroir rond", "Cadre photo", "Horloge murale", "Vase verre", "Savon olive",
  "Brosse bambou", "Tablier coton", "Mug émaillé", "Porte-clés cuir", "Chaussettes laine", "Bonnet tricot",
  "Écharpe soie", "Gants jardin", "Arrosoir zinc", "Pot terre cuite", "Lunettes soleil", "Parapluie pliant",
];
const VARIANTS = ["350 ml", "500 ml", "S", "M", "L", "XL", "noir", "blanc", "bleu nuit", "vert sauge", "lot de 2", "lot de 4", "20 cm", "30 cm"];
const CARTONS = [6, 12, 24, 36, 48, 50, 100];

/** A line: invented name, prices per piece, carton, quantity, PP (cost below the min price). */
function makeLine(rnd, name, status, opts = {}) {
  const ppc = opts.ppc ?? rnd.pick(CARTONS);
  const qty = opts.qty ?? ppc * (1 + rnd.int(40));
  const min = opts.min ?? toCents(rnd.range(0.5, 40));
  const max = opts.max ?? Math.round(min * (1.1 + rnd.int(40) / 100));
  const costPerPieceRatio = 0.4 + rnd.int(30) / 100;
  const pp = opts.pp !== undefined ? opts.pp : Math.round(qty * min * costPerPieceRatio);
  return { name, status, ppc, qty, min, max, pp };
}

/** Cells in Haider's column order, French style; REVENTE computed as QUANTITE x PRIX unless overridden. */
function frCells(l, o = {}) {
  return [
    l.name,
    o.maxText ?? fr(l.max),
    o.minText ?? fr(l.min),
    o.qtyText ?? String(l.qty),
    o.ppcText ?? String(l.ppc),
    o.ppText ?? (l.pp === null ? "" : fr(l.pp)),
    o.rminText ?? fr(l.qty * l.min),
    o.rmaxText ?? fr(l.qty * l.max),
    o.statusText ?? (l.status === "warehouse" ? "In Warehouse" : "In Transit"),
  ];
}

function csv(rows, delimiter) {
  const cell = (v) => (/["\r\n]/.test(v) || v.includes(delimiter) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map(cell).join(delimiter)).join("\r\n") + "\r\n";
}

// ---------- stock-40-fake.csv ----------

function build40(seed) {
  const rnd = makeRandom(seed);
  const names = [];
  const used = new Set();
  while (names.length < 30) {
    const n = `${rnd.pick(ITEMS)} ${rnd.pick(VARIANTS)}`;
    if (!used.has(n)) {
      used.add(n);
      names.push(n);
    }
  }
  const rows = []; // [cells, label]
  const add = (cells, label) => rows.push({ cells, label });
  const W = (i, o = {}) => makeLine(rnd, names[i], "warehouse", o);
  // Ready: 20 warehouse products.
  const w = [];
  w[0] = W(0, { ppc: 24, qty: 1200 });
  add(frCells(w[0], { qtyText: `1${NNBSP}200` }), { fixes: [] });
  w[1] = W(1, { min: 1000, max: 1250 });
  add(frCells(w[1], { maxText: "12,50 €" }), { fixes: [] });
  w[2] = W(2);
  add(frCells(w[2], { statusText: "In warehouse " }), { fixes: [] });
  w[3] = W(3);
  add(frCells(w[3], { statusText: "Entrepôt" }), { fixes: [] });
  w[4] = W(4, { qty: 0, pp: null });
  add(frCells(w[4]), { fixes: [] });
  w[5] = W(5, { qty: 0, pp: 15000 });
  add(frCells(w[5]), { fixes: ["cost_kept_sold_out"] });
  w[6] = W(6);
  add(frCells(w[6], { rmaxText: fr(Math.round(w[6].qty * w[6].max * 1.1) + 100) }), { fixes: ["resale_max_mismatch"] });
  w[7] = W(7);
  add(frCells(w[7], { rminText: fr(Math.round(w[7].qty * w[7].min * 0.9) - 100) }), { fixes: ["resale_min_mismatch"] });
  w[8] = W(8);
  add(frCells(w[8], { rmaxText: fr(Math.round(w[8].qty * w[8].max * 1.2)) }), { fixes: ["resale_max_mismatch"] });
  w[9] = W(9, { pp: null });
  add(frCells(w[9]), { fixes: ["cost_missing"] });
  w[10] = W(10, { ppc: 10, qty: 100, min: 200, max: 300, pp: 50000 });
  add(frCells(w[10]), { fixes: ["cost_above_price"] });
  w[11] = W(11, { ppc: 12, qty: 130 });
  add(frCells(w[11]), { fixes: ["loose_pieces"] });
  w[12] = W(12);
  add(frCells({ ...w[12], name: '=HYPERLINK("http://example.invalid")' }), { fixes: [], name: '=HYPERLINK("http://example.invalid")' });
  w[13] = W(13);
  add(frCells({ ...w[13], name: "<img src=x onerror=alert(1)>" }), { fixes: [], name: "<img src=x onerror=alert(1)>" });
  w[14] = W(14);
  add(frCells({ ...w[14], name: `Étiquette ${"‮"}cadeau` }), { fixes: [], name: "Étiquette cadeau" });
  for (let i = 15; i < 20; i++) {
    w[i] = W(i);
    add(frCells(w[i]), { fixes: [] });
  }
  // 6 transit products, statuses spelled differently.
  const transitSpellings = ["EN TRANSIT", "In Transit", "en mer", "In transit", "Transit", "EN TRANSIT"];
  const t = [];
  for (let i = 0; i < 6; i++) {
    t[i] = makeLine(rnd, names[20 + i], "transit");
    add(frCells(t[i], { statusText: transitSpellings[i] }), { fixes: [] });
  }
  // 2 products listed in both places (the second with a different transit price: prices_differ, from the database).
  for (let i = 0; i < 2; i++) {
    const both = makeLine(rnd, names[26 + i], "warehouse");
    add(frCells(both), { fixes: [] });
    const tr = { ...both, status: "transit", qty: both.ppc * (2 + i), pp: Math.round(both.ppc * (2 + i) * both.min * 0.5) };
    if (i === 1) tr.max = both.max + 100;
    add(frCells(tr), { fixes: [], dbWarnings: i === 1 ? ["prices_differ"] : [] });
  }
  // Repeated: case and accent variants of a ready row, same place.
  add(frCells({ ...w[15], name: w[15].name.toUpperCase() }), { repeatedOf: 17 });
  const accentless = t[0].name.normalize("NFD").replace(/\p{M}/gu, "");
  add(frCells({ ...t[0], name: accentless === t[0].name ? `${t[0].name.toLowerCase()}` : accentless }, { statusText: "en transit" }), {
    repeatedOf: 22,
  });
  // Can't import.
  const bad = makeLine(rnd, names[28], "warehouse");
  add(frCells(bad, { minText: fr(bad.max + 100) }), { problems: ["price_order"] });
  add(frCells(makeLine(rnd, names[29], "warehouse"), { qtyText: "beaucoup" }), { problems: ["quantity_invalid"] });
  add(frCells(makeLine(rnd, "Ruban satin 10 m", "warehouse"), { qtyText: "-5", rminText: "", rmaxText: "" }), {
    problems: ["quantity_negative"],
  });
  add(frCells(makeLine(rnd, "Ficelle jute 50 m", "warehouse"), { qtyText: "12,5", rminText: "", rmaxText: "" }), {
    problems: ["quantity_not_whole"],
  });
  add(frCells(makeLine(rnd, "Pince à linge bois", "warehouse"), { ppcText: "0" }), { problems: ["carton_invalid"] });
  add(frCells(makeLine(rnd, "", "warehouse")), { problems: ["name_missing"] });
  add(frCells(makeLine(rnd, "Crochet adhésif", "warehouse"), { qtyText: "#VALEUR!", rminText: "", rmaxText: "" }), {
    problems: ["excel_error"],
  });
  // One blank line, kept in place (between the ready rows and the rest).
  const blankAt = 30; // index in rows: spreadsheet row 32
  rows.splice(blankAt, 0, { cells: HEADER.map(() => ""), label: { blank: true } });
  return { rows, warehouse: w, transit: t };
}

function expectedFor(rows) {
  const labels = {};
  rows.forEach((r, i) => {
    const rowNo = i + 2;
    if (r.label.blank) return;
    if (r.label.problems) labels[rowNo] = { problems: r.label.problems };
    else if (r.label.repeatedOf) labels[rowNo] = { fixes: [], repeated_of: r.label.repeatedOf };
    else labels[rowNo] = { fixes: r.label.fixes, ...(r.label.dbWarnings?.length ? { db_warnings: r.label.dbWarnings } : {}) };
  });
  return labels;
}

// ---------- the other sheets ----------

function buildEn(seed) {
  const rnd = makeRandom(seed + 1);
  const header = ["Product name", "Selling price max", "Selling price min", "Quantity", "Units per carton", "Total cost", "Resale min", "Resale max", "Status"];
  const rows = [header];
  for (let i = 0; i < 8; i++) {
    const l = makeLine(rnd, `Test item EN ${i + 1}`, i < 6 ? "warehouse" : "transit");
    if (i === 0) l.qty = 1200 - (1200 % l.ppc);
    rows.push([l.name, en(l.max), en(l.min), i === 0 ? l.qty.toLocaleString("en-US") : String(l.qty), String(l.ppc), en(l.pp), en(l.qty * l.min), en(l.qty * l.max), l.status === "warehouse" ? "Warehouse" : "Shipped"]);
  }
  return csv(rows, ",");
}

function buildParens(seed) {
  const rnd = makeRandom(seed + 2);
  const header = ["Produit", "Prix (max)", "Prix (min)", "Quantité", "Colisage", "PP", "Revente (min)", "Revente (max)", "Statut"];
  const rows = [header];
  for (let i = 0; i < 6; i++) {
    const l = makeLine(rnd, `Article parenthèses ${i + 1}`, i < 4 ? "warehouse" : "transit");
    rows.push(frCells(l, { statusText: l.status === "warehouse" ? "En stock" : "En route" }));
  }
  return BOM + csv(rows, ";");
}

// After stock-40 is imported (and one product sold in the CRM): 4 new quantities, 2 new prices, a transit product now
// In Warehouse, 2 new products, 1 unchanged, 1 product sold in the CRM in between (kept by default).
function buildReimport(seed, base) {
  const rnd = makeRandom(seed + 3);
  const { warehouse: w, transit: t } = base;
  const rows = [HEADER];
  const labels = {};
  const push = (cells, label) => {
    rows.push(cells);
    labels[rows.length] = label;
  };
  for (const i of [0, 2, 3, 15]) {
    const l = { ...w[i], qty: w[i].qty + w[i].ppc * 2 };
    push(frCells(l, { statusText: "In Warehouse" }), { change: "quantity" });
  }
  for (const i of [16, 17]) {
    const l = { ...w[i], min: w[i].min + 10, max: w[i].max + 20 };
    push(frCells(l), { change: "price" });
  }
  push(frCells({ ...t[1], status: "warehouse" }, { statusText: "In Warehouse" }), { change: "arrived" });
  for (let i = 0; i < 2; i++) push(frCells(makeLine(rnd, `Nouveauté réassort ${i + 1}`, "warehouse")), { change: "new" });
  push(frCells(w[18]), { change: "unchanged" });
  push(frCells(w[19]), { change: "sold_in_crm" });
  return { text: BOM + csv(rows, ";"), labels };
}

function buildPerf(seed, n) {
  const rnd = makeRandom(seed + 9);
  const rows = [HEADER];
  for (let i = 0; i < n; i++) {
    const l = makeLine(rnd, `Produit perf ${String(i + 1).padStart(5, "0")}`, i % 5 === 4 ? "transit" : "warehouse");
    rows.push(frCells(l));
  }
  return BOM + csv(rows, ";");
}

function cp1252(text) {
  // Characters outside Windows-1252 become their nearest neighbour (NNBSP -> NBSP; bidi controls dropped).
  const map = { "€": 0x80, "’": 0x92 };
  const clean = text.replace(/ /g, NBSP).replace(/[‪-‮﻿]/g, "");
  const out = [];
  for (const ch of clean) {
    const code = ch.codePointAt(0);
    if (map[ch] !== undefined) out.push(map[ch]);
    else if (code <= 0xff) out.push(code);
    else throw new Error(`not in Windows-1252: U+${code.toString(16)}`);
  }
  return Buffer.from(out);
}

function buildAll(seed) {
  const base = build40(seed);
  const text40 = BOM + csv([HEADER, ...base.rows.map((r) => r.cells)], ";");
  const reimport = buildReimport(seed, base);
  const labels = expectedFor(base.rows);
  const dataRows = base.rows.filter((r) => !r.label.blank).length;
  const expected = {
    file: "stock-40-fake.csv",
    generator: `scripts/make-fake-stock.mjs --seed ${seed}`,
    header: HEADER,
    delimiter: ";",
    encoding: "utf-8",
    number_style: "fr",
    row_count: dataRows,
    last_row_no: base.rows.length + 1,
    blank_row_nos: base.rows.flatMap((r, i) => (r.label.blank ? [i + 2] : [])),
    browser: {
      rejected: Object.values(labels).filter((l) => l.problems).length,
      warnings: Object.values(labels).reduce((acc, l) => {
        for (const f of l.fixes ?? []) acc[f] = (acc[f] ?? 0) + 1;
        return acc;
      }, {}),
    },
    // The check on an empty catalogue (design 7.9 tiles).
    check_on_empty_catalogue: { products_new: 28, products_update: 0, products_moved: 0, rejected: 7, repeated: 2, products_unchanged: 0 },
    names: {
      formula: '=HYPERLINK("http://example.invalid")',
      html: "<img src=x onerror=alert(1)>",
      bidi_stripped: "Étiquette cadeau",
    },
    rows: labels,
    reimport: { file: "stock-reimport-fake.csv", rows: reimport.labels },
  };
  return {
    "stock-40-fake.csv": text40,
    "stock-40-fake-cp1252.csv": cp1252(text40),
    "stock-en-headers.csv": buildEn(seed),
    "stock-parens-only.csv": buildParens(seed),
    "stock-reimport-fake.csv": reimport.text,
    "expected.json": JSON.stringify(expected, null, 2) + "\n",
  };
}

function parseArgs(argv) {
  const args = { seed: DEFAULT_SEED, rows: null, out: null, check: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--check") args.check = true;
    else if (flag === "--seed") args.seed = Number(argv[++i]);
    else if (flag === "--rows") args.rows = Number(argv[++i]);
    else if (flag === "--out") args.out = argv[++i];
    else throw new Error(`unknown option ${flag}`);
  }
  if (!Number.isInteger(args.seed)) throw new Error("--seed needs a whole number");
  if (args.rows !== null && (!Number.isInteger(args.rows) || args.rows < 1 || args.rows > 5000)) throw new Error("--rows 1 to 5000");
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.rows !== null) {
    const out = args.out ?? ".";
    mkdirSync(out, { recursive: true });
    const file = path.join(out, `stock-${args.rows}-perf.csv`);
    writeFileSync(file, buildPerf(args.seed, args.rows));
    console.log(file);
    return;
  }
  const files = buildAll(args.seed);
  if (args.check) {
    const differs = Object.entries(files).filter(([name, content]) => {
      const file = path.join(FIXTURES, name);
      return !existsSync(file) || !readFileSync(file).equals(Buffer.from(content));
    });
    for (const [name] of differs) console.error(`differs: tests/fixtures/stock/${name}`);
    process.exit(differs.length ? 1 : 0);
  }
  mkdirSync(FIXTURES, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(FIXTURES, name), content);
}

main();
