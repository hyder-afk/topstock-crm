#!/usr/bin/env node
// Fake lead sheets for the import tests (design docs/evidence/day3b/design.md, section 6D).
//
// Deterministic: a seeded PRNG (mulberry32), no clock and no Math.random, so every run writes byte-identical files.
// Fake data only: invented company names, addresses at example.com/.org/.net, fictional phone ranges
// (FR 01 99 00 xx xx and 06 39 98 xx xx, UK 020 7946 0xxx and 07700 900xxx, US 555-01xx).
// Future dates use years from 2030, so which rows are "in the future" never depends on today's date.
//
//   node scripts/make-fake-leads.mjs                                writes tests/fixtures/import/ (committed)
//   node scripts/make-fake-leads.mjs --rows 30000 --out /tmp/perf   one large, fully importable file (never committed)
//   node scripts/make-fake-leads.mjs --check                        exits 1 if the committed fixtures differ from the output
//   options: --seed N (default 20261010)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "import");
const DEFAULT_SEED = 20261010;
const HEADER = [
  "Company name",
  "Company owner",
  "Phone Number",
  "Email",
  "Lead Status",
  "Last Activity Date",
  "City",
  "Country/Region",
];
const BOM = "\uFEFF";

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
  return {
    int,
    pick: (list) => list[int(list.length)],
    chance: (p) => next() < p,
    shuffle(list) {
      const out = [...list];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(i + 1);
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}

// ---------- the name key of the import contract (used to keep invented names apart) ----------

function fold(s) {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .replace(/ß/g, "ss");
}
const PUNCT = /[\u0000-/:-@[-`{-\u007F\u00A0-¿\u2000-\u206F]/g;
const LEGAL = /(^| )(sarl|sas|sasu|sa|eurl|snc|sci|selarl|ltd|limited|llc|inc|gmbh|bv|srl|plc)(?= |$)/g;
function nameKeyPart(name) {
  const spaced = ` ${fold(name).replace(/\./g, "").replace(PUNCT, " ")} `.replace(/ +/g, "  ");
  const stripped = spaced.replace(LEGAL, " ");
  return (stripped.trim() ? stripped : spaced).replace(/\s+/g, "");
}

const ascii = (s) => s.normalize("NFD").replace(/\p{M}/gu, "");
const pad = (n, width = 2) => String(n).padStart(width, "0");

// ---------- value pools ----------

const PREFIXES = [
  "Maison", "Atelier", "Comptoir", "Épicerie", "Boulangerie", "Négoce", "Bazar", "Dépôt", "Marché", "Galerie",
  "Fromagerie", "Brasserie", "Droguerie", "Quincaillerie", "Librairie", "Cave", "Studio", "Distribution", "Trading",
  "Import",
];
const CORES = [
  "Verdane", "Orion", "Azur", "Belle Rive", "Saint-Clair", "des Halles", "du Port", "Lumière", "Montclar", "Valmont",
  "Rosalie", "Marbeuf", "Clairval", "Hautecombe", "Beaulieu", "Ventadour", "Mirabel", "Castelnau", "Fontenelle",
  "Grandpré", "Lavandière", "Morvan", "Peyrac", "Quillan", "Roussel", "Sauvigny", "Tarnac", "Ussel", "Vauclair",
  "Willemin", "Ardoise", "Bruyère", "Cèdre", "Douce Vallée", "Écluse", "Falaise", "Garrigue", "Héron", "Iris",
  "Jonquille",
];

const COUNTRIES = {
  FR: {
    labels: ["France", "FR", "fr"],
    cities: ["Paris", "Lyon", "Marseille", "Lille", "Bordeaux", "Nantes", "Toulouse", "Nice", "Strasbourg", "Rennes",
      "Montpellier", "Grenoble", "Dijon", "Angers", "Reims"],
    phone: "fr",
  },
  GB: { labels: ["Royaume-Uni", "UK"], cities: ["London", "Manchester", "Leeds", "Bristol"], phone: "uk" },
  US: { labels: ["USA", "États-Unis"], cities: ["New York", "Chicago", "Boston", "Seattle"], phone: "us" },
  DE: { labels: ["Deutschland"], cities: ["Berlin", "Hamburg", "München"], phone: "fr" },
  BE: { labels: ["Belgique"], cities: ["Bruxelles", "Liège", "Gand"], phone: "fr" },
  ES: { labels: ["España"], cities: ["Madrid", "Barcelona", "Valencia"], phone: "fr" },
  CI: { labels: ["Côte d'Ivoire"], cities: ["Abidjan", "Yamoussoukro"], phone: "fr" },
  MA: { labels: ["Maroc"], cities: ["Casablanca", "Rabat"], phone: "fr" },
};
const COUNTRY_LABELS = Object.entries(COUNTRIES).flatMap(([code, c]) => c.labels.map((label) => ({ code, label })));
const ALL_CITIES = Object.values(COUNTRIES).flatMap((c) => c.cities);

// Haider's spelling plus case, space and HubSpot variants; every one is suggested without a click.
const STATUS_VARIANTS = [
  "Cold", "Warm (in progress)", "Negotiation", "Customer", "Cool off", "Do not contact", "Disqualified", "COLD",
  " customer ", "Warm (In Progress)", "IN_PROGRESS", "Cool-off", "cool off", "DO NOT CONTACT", "negotiation",
  "DISQUALIFIED", "Client", "dnc", "Unqualified",
];
const OWNERS = ["Haider Test", "Henri Test", "kais test"];

function nameSource(rnd) {
  const combos = rnd.shuffle(PREFIXES.flatMap((p) => CORES.map((c) => `${p} ${c}`)));
  const used = new Set();
  let i = 0;
  return {
    /** Marks an explicit name (and its key) as taken, so no invented name can fold to the same key. */
    reserve(name) {
      used.add(nameKeyPart(name));
      return name;
    },
    next() {
      while (i < combos.length) {
        const name = combos[i++];
        const key = nameKeyPart(name);
        if (!used.has(key)) {
          used.add(key);
          return name;
        }
      }
      throw new Error("out of invented names");
    },
  };
}

// partition 0: fixtures (FR xx xx 0000-4999, all UK and US numbers); partition 1: perf files (FR 5000-9999).
function phoneSource(rnd, partition) {
  const range = (n, offset) => rnd.shuffle(Array.from({ length: n }, (_, i) => i + offset));
  const pools = {
    frFixed: range(5000, partition * 5000),
    frMobile: range(5000, partition * 5000),
    ukFixed: partition ? [] : range(1000, 0),
    ukMobile: partition ? [] : range(1000, 0),
    us: partition ? [] : rnd.shuffle([202, 213, 312, 415, 617, 718].flatMap((a) => Array.from({ length: 100 }, (_, i) => [a, i]))),
  };
  const take = (pool) => {
    if (!pools[pool].length) throw new Error(`out of ${pool} numbers`);
    return pools[pool].pop();
  };
  return {
    frFixed: () => ({ kind: "frFixed", n: take("frFixed") }),
    frMobile: () => ({ kind: "frMobile", n: take("frMobile") }),
    ukFixed: () => ({ kind: "ukFixed", n: take("ukFixed") }),
    ukMobile: () => ({ kind: "ukMobile", n: take("ukMobile") }),
    us: () => ({ kind: "us", n: take("us") }),
    forCountry(code) {
      const kind = COUNTRIES[code]?.phone ?? "fr";
      if (kind === "uk") return rnd.chance(0.5) ? this.ukFixed() : this.ukMobile();
      if (kind === "us") return this.us();
      return rnd.chance(0.5) ? this.frFixed() : this.frMobile();
    },
  };
}

/** Writes a phone in one of several styles (all with the same last 9 digits, so the same dedupe key). */
function formatPhone(p, style = "national") {
  if (p.kind === "frFixed" || p.kind === "frMobile") {
    const [lead, mid] = p.kind === "frFixed" ? ["1", "99 00"] : ["6", "39 98"];
    const tail = pad(p.n, 4);
    const ab = tail.slice(0, 2);
    const cd = tail.slice(2);
    const groups = `${mid} ${ab} ${cd}`;
    switch (style) {
      case "intl": return `+33 ${lead} ${groups}`;
      case "dots": return `0${lead}.${groups.replace(/ /g, ".")}`;
      case "zero_zero": return `0033 ${lead} ${groups}`;
      case "trunk": return `+33 (0)${lead} ${groups}`;
      case "dashes": return `0${lead}-${groups.replace(/ /g, "-")}`;
      case "compact": return `0${lead}${groups.replace(/ /g, "")}`;
      default: return `0${lead} ${groups}`;
    }
  }
  if (p.kind === "ukFixed") {
    const tail = `0${pad(p.n, 3)}`;
    if (style === "intl") return `+44 20 7946 ${tail}`;
    if (style === "trunk") return `+44 (0)20 7946 ${tail}`;
    return `020 7946 ${tail}`;
  }
  if (p.kind === "ukMobile") return style === "intl" ? `+44 7700 900${pad(p.n, 3)}` : `07700 900${pad(p.n, 3)}`;
  const [area, n] = p.n;
  if (style === "intl") return `+1 ${area}-555-01${pad(n)}`;
  if (style === "dashes") return `${area}-555-01${pad(n)}`;
  return `(${area}) 555-01${pad(n)}`;
}

function emailSource(rnd, tag = "") {
  const locals = ["contact", "info", "ventes", "achats", "hello", "sales", "commandes", "bonjour"];
  const tlds = ["com", "org", "net"];
  let n = 0;
  return (name) => {
    n++;
    const slug = ascii(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "lead";
    return `${rnd.pick(locals)}.${slug}.${tag}${n}@example.${rnd.pick(tlds)}`;
  };
}

// Dates in the past, written with a day above 12 (so the file reads as day-first) or year-first.
function dateSource(rnd) {
  const ymd = () => {
    const y = 2021 + rnd.int(6);
    const m = y === 2026 ? 1 + rnd.int(8) : 1 + rnd.int(12);
    return [y, m, 13 + rnd.int(16)];
  };
  const formats = ["dmy", "dmy_time", "iso", "dot", "dash2", "iso_time"];
  let turn = 0;
  return {
    normal() {
      const [y, m, d] = ymd();
      const hh = pad(8 + rnd.int(11));
      const mi = pad(rnd.int(60));
      switch (formats[turn++ % formats.length]) {
        case "dmy": return `${pad(d)}/${pad(m)}/${y}`;
        case "dmy_time": return `${pad(d)}/${pad(m)}/${y} ${hh}:${mi}`;
        case "iso": return `${y}-${pad(m)}-${pad(d)}`;
        case "dot": return `${pad(d)}.${pad(m)}.${y}`;
        case "dash2": return `${pad(d)}-${pad(m)}-${pad(y % 100)}`;
        default: return `${y}-${pad(m)}-${pad(d)} ${hh}:${mi}:${pad(rnd.int(60))}`;
      }
    },
    // Reads either way (03/04/2025): day and month both 1-12 and different.
    ambiguous() {
      const y = 2022 + rnd.int(4);
      const d = 1 + rnd.int(12);
      const m = ((d + rnd.int(11)) % 12) + 1;
      return `${pad(d)}/${pad(m)}/${y}`;
    },
  };
}

// ---------- CSV writing ----------

function csvLine(cells, delimiter) {
  return cells
    .map((cell) => (/["\r\n]/.test(cell) || cell.includes(delimiter) ? `"${cell.replace(/"/g, '""')}"` : cell))
    .join(delimiter);
}

const CP1252_HIGH = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87],
  [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91],
  [0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97], [0x02dc, 0x98],
  [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

function encodeWindows1252(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) out[i] = c;
    else if (CP1252_HIGH.has(c)) out[i] = CP1252_HIGH.get(c);
    else throw new Error(`not in Windows-1252: U+${c.toString(16)}`);
  }
  return out;
}

// ---------- the 500-row sample, existing-20 and the French file ----------

function buildFixtures(seed) {
  const rnd = makeRandom(seed);
  const names = nameSource(rnd);
  const phones = phoneSource(rnd, 0);
  const email = emailSource(rnd);
  const dates = dateSource(rnd);
  let ownerTurn = 0;
  let statusTurn = 0;
  let countryTurn = 0;
  const nextOwner = () => OWNERS[ownerTurn++ % OWNERS.length];
  const nextStatus = () => STATUS_VARIANTS[statusTurn++ % STATUS_VARIANTS.length];
  const nextCountry = () => COUNTRY_LABELS[countryTurn++ % COUNTRY_LABELS.length];
  const codeOf = (label) => COUNTRY_LABELS.find((c) => c.label === label)?.code ?? null;

  const rows = [];
  const add = (fields, label, links = {}) => {
    const row = { fields: { extra: [], ...fields }, label: { tags: [], ...label }, ...links };
    rows.push(row);
    return row;
  };
  const ready = (fields, tags = []) => add(fields, { expect: "ready", tags });

  // ----- existing-20.csv: what is already in the CRM -----
  const existing = [];
  for (let i = 0; i < 10; i++) {
    const name = names.next();
    const { code, label } = nextCountry();
    existing.push({
      key: "email",
      fields: {
        name, owner: nextOwner(), phone: formatPhone(phones.forCountry(code)), email: email(name), status: nextStatus(),
        date: dates.normal(), city: rnd.pick(COUNTRIES[code].cities), country: label,
      },
    });
  }
  const existingPhones = [
    [phones.frFixed(), "national", "intl", "France", "Paris"],
    [phones.frFixed(), "national", "trunk", "FR", "Lyon"],
    [phones.frFixed(), "national", "compact", "France", "Lille"],
    [phones.ukFixed(), "national", "intl", "UK", "London"],
    [phones.us(), "national", "intl", "USA", "Boston"],
  ];
  for (const [p, have, sheet, country, city] of existingPhones) {
    existing.push({
      key: "phone",
      sheetPhone: formatPhone(p, sheet),
      fields: {
        name: names.next(), owner: nextOwner(), phone: formatPhone(p, have), email: "", status: nextStatus(),
        date: dates.normal(), city, country,
      },
    });
  }
  // Name + city + country, no email or phone; the sample spells them differently.
  const existingNames = [
    ["Fromagerie Valmont Haute", "Reims", "France", "FROMAGERIE VALMONT HAUTE", "reims", "fr"],
    ["Atelier Héron Bleu", "Toulouse", "FR", "Atelier Heron Bleu SARL", "Toulouse", "France"],
    ["Comptoir Marbeuf Ltd", "London", "UK", "Comptoir Marbeuf", "London", "Royaume-Uni"],
    ["Galerie Clairval-Sud", "Marseille", "France", "Galerie Clairval Sud.", "Marseille", "FR"],
    ["Société Écluse Neuve", "Nice", "France", "Societe Ecluse Neuve", "NICE", "fr"],
  ];
  for (const [name, city, country, sheetName, sheetCity, sheetCountry] of existingNames) {
    names.reserve(name);
    existing.push({
      key: "name",
      sheet: { name: sheetName, city: sheetCity, country: sheetCountry },
      fields: { name, owner: nextOwner(), phone: "", email: "", status: nextStatus(), date: dates.normal(), city, country },
    });
  }
  const existingOrder = rnd.shuffle(existing);
  existingOrder.forEach((e, i) => (e.row_no = i + 2));

  // ----- 20 already in the CRM -----
  const emailCase = [
    (e) => e.toUpperCase(),
    (e) => `  ${e}  `,
    (e) => `mailto:${e}`,
    (e) => e.charAt(0).toUpperCase() + e.slice(1),
    (e) => `MAILTO:${e.toUpperCase()}`,
  ];
  let variant = 0;
  for (const e of existing) {
    if (e.key === "email") {
      add({ name: e.fields.name, phone: "", email: emailCase[variant++ % emailCase.length](e.fields.email) },
        { expect: "duplicate_existing", match_key: "email", tags: ["existing_email"] }, { existing: e });
    } else if (e.key === "phone") {
      add({ name: names.next(), phone: e.sheetPhone, email: "" },
        { expect: "duplicate_existing", match_key: "phone", tags: ["existing_phone"] }, { existing: e });
    } else {
      add({ name: e.sheet.name, phone: "", email: "", city: e.sheet.city, country: e.sheet.country },
        { expect: "duplicate_existing", match_key: "name", tags: ["existing_name"] }, { existing: e });
    }
  }

  // ----- 30 repeated in the file, with their keepers (ready) -----
  for (let i = 0; i < 12; i++) {
    const name = names.next();
    const e = email(name);
    const keeper = ready({ name, email: e, contact: "phone" }, ["keeper"]);
    add({ name: i % 2 ? name : names.next(), phone: "", email: emailCase[i % emailCase.length](e) },
      { expect: "duplicate_file", match_key: "email", tags: ["repeat_email"] }, { after: keeper });
  }
  const phoneStyles = ["national", "dots", "zero_zero", "trunk", "dashes"];
  for (let i = 0; i < 10; i++) {
    const p = phones.frMobile();
    const name = names.next();
    const keeper = ready({ name, phone: formatPhone(p, "intl"), email: i % 2 ? email(name) : "" }, ["keeper"]);
    add({ name: names.next(), phone: formatPhone(p, phoneStyles[i % 5]), email: "" },
      { expect: "duplicate_file", match_key: "phone", tags: ["repeat_phone", `phone_${phoneStyles[i % 5]}`] }, { after: keeper });
  }
  const nameRepeats = [
    ["Épicerie Fine Bruyère", "Lyon", "France", "Epicerie Fine Bruyere", "Lyon", "FR", "accents"],
    ["Maison Ventadour Frères", "Nantes", "France", "MAISON VENTADOUR FRÈRES", "nantes", "fr", "case"],
    ["Négoce Morvan Est", "Lille", "FR", "Négoce Morvan Est S.A.R.L.", "Lille", "France", "legal_form"],
    ["Cave Saint-Clair Ouest", "Bordeaux", "France", "Cave Saint Clair Ouest!!", "Bordeaux", "France", "punctuation"],
    ["Brasserie Peyrac Sud SAS", "Saint-Étienne", "France", "Brasserie Peyrac Sud", "Saint Etienne", "FR", "city_spelling"],
  ];
  for (const [name, city, country, repeatName, repeatCity, repeatCountry, how] of nameRepeats) {
    names.reserve(name);
    const keeper = ready({ name, phone: "", email: "", city, country }, ["keeper", "no_contact"]);
    add({ name: repeatName, phone: "", email: "", city: repeatCity, country: repeatCountry },
      { expect: "duplicate_file", match_key: "name", tags: ["repeat_name", how] }, { after: keeper });
  }
  // No-contact rows placed before a row with contact details and the same name + city: that row is kept.
  const beforeContact = [
    ["Quincaillerie Mirabel Nord", "Grenoble", "France", "QUINCAILLERIE MIRABEL NORD", "France", "email"],
    ["Librairie Castelnau Centre", "Dijon", "FR", "Librairie Castelnau Centre", "France", "phone"],
    ["Droguerie Fontenelle Gare", "Angers", "fr", "Droguerie Fontenelle-Gare", "FR", "both"],
  ];
  for (const [name, city, country, earlyName, earlyCountry, contact] of beforeContact) {
    names.reserve(name);
    const keeper = ready({ name, city, country, contact }, ["keeper", "contact_after_no_contact"]);
    add({ name: earlyName, phone: "", email: "", city, country: earlyCountry },
      { expect: "duplicate_file", match_key: "name", tags: ["no_contact_before_contact"] }, { before: keeper });
  }

  // ----- 50 can't be imported -----
  const rejected = (fields, problems, tags = []) => add(fields, { expect: "rejected", problems, tags });
  const missingNames = ["", "   ", "\u00A0", "\u200B", "\u00A0\u200B ", "n/a", "-", "\t", "NULL", " \u200B\u00A0\u200B "];
  const repeatedPhone = phones.frMobile();
  let rejectedWithPhone = null;
  missingNames.forEach((name, i) => {
    const row = rejected(
      i === 0 ? { name, phone: formatPhone(repeatedPhone, "intl"), email: "" } : { name, contact: "email" },
      ["name_missing"],
      i === 0 ? ["missing_name", "phone_reused_later"] : ["missing_name"],
    );
    if (i === 0) rejectedWithPhone = row;
  });
  const longNames = [
    `Comptoir des Délices ${"\u{1F353}".repeat(180)}`, // 201 characters, 381 UTF-16 units
    `Distribution ${"Internationale ".repeat(16)}Lumière`.slice(0, 250),
    `Négociants Associés ${"Épices et Thés ".repeat(32)}`.trim(),
  ];
  for (const name of longNames) rejected({ name, contact: "both" }, ["name_too_long"], ["long_name"]);
  const badEmails = [
    ["=HYPERLINK(\"http://example.invalid\")", "contact@example", ["formula_name"]],
    ["+SUM(1,1)", "ventes.example.com", ["formula_name"]],
    ["-2+3", "contact@@example.com", ["formula_name"]],
    ["@cmd", "@example.com", ["formula_name"]],
    [null, "info@example..com", []],
    [null, "jean dupont@example.org", []],
    [null, "a@b@example.net", []],
    [null, "contact@example.com, ventes@example.com", []],
    [null, "contact@example.org;achats@example.net", []],
    [null, "contact@.example.org", []],
    [null, "contact@", []],
    [null, `${"tres.long.adresse.".repeat(14)}x@example.com`, ["email_over_254"]],
  ];
  for (const [name, bad, tags] of badEmails) {
    rejected({ name: name ?? names.next(), email: bad, contact: "phone" }, ["email_invalid"], ["bad_email", ...tags]);
  }
  const badPhones = [
    ["ext 12", "phone_invalid"],
    ["06 39 98 AB CD", "phone_invalid"],
    ["3.36E+11", "phone_mangled"],
    ["6.12345678E+8", "phone_mangled"],
    ["+33 1 99 00 12 34 / +33 6 39 98 12 34 / 1", "phone_too_long"],
    ["12345", "phone_invalid"],
    ["+33 6 39 98 12 34 poste 5", "phone_invalid"],
    ["06 39 98 12 34 #2", "phone_invalid"],
  ];
  for (const [bad, problem] of badPhones) {
    rejected({ name: names.next(), phone: bad, contact: "email" }, [problem], ["bad_phone"]);
  }
  const badDates = [
    ["31/02/2024", "date_invalid"],
    ["32/01/2023", "date_invalid"],
    ["00/00/0000", "date_invalid"],
    ["12/2023", "date_invalid"],
    ["2024-13-01", "date_invalid"],
    ["yesterday", "date_invalid"],
    ["15/06/2031", "date_future"],
    ["2030-01-01", "date_future"],
    ["28/12/2035 14:00", "date_future"],
    ["15/06/1985", "date_too_old"],
    ["01/01/1970", "date_too_old"],
  ];
  for (const [bad, problem] of badDates) {
    rejected({ name: names.next(), date: bad, contact: "both" }, [problem], ["bad_date"]);
  }
  const extras = [["Note libre"], ["", "oops"], ["x", "y"]];
  for (const extra of extras) rejected({ name: names.next(), contact: "both", extra }, ["columns_extra"], ["extra_columns"]);
  const longCities = [
    `Saint-${"Rémy-de-la-Vallée-".repeat(7)}Haute`, // > 120 characters
    `${"Ville Nouvelle ".repeat(10)}Centre`,
    "Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch ".repeat(4).trim(),
  ];
  for (const city of longCities) rejected({ name: names.next(), city, country: "France", contact: "both" }, ["city_too_long"], ["long_city"]);

  // ----- near misses that must import -----
  const sameName = names.reserve("Boulangerie Lavandière Est");
  ready({ name: sameName, phone: "", email: "", city: "Lyon", country: "France" }, ["same_name_other_city"]);
  ready({ name: sameName, phone: "", email: "", city: "Bordeaux", country: "France" }, ["same_name_other_city"]);
  const chain = names.reserve("Supérette Bellevue Express");
  ready({ name: chain, phone: formatPhone(phones.frFixed()), email: "", city: "Paris", country: "France" }, ["chain_store"]);
  ready({ name: chain, phone: formatPhone(phones.frFixed(), "intl"), email: "", city: "Paris", country: "FR" }, ["chain_store"]);
  const repeatsRejected = ready({ name: names.next(), phone: formatPhone(repeatedPhone, "national"), email: "" }, ["repeats_rejected_row"]);

  // ----- name only (10): blank status, owner, country and date; two share a name and have no city -----
  const noCity = names.reserve("Épicerie Azur Marine");
  const nameOnly = [noCity, noCity, ...Array.from({ length: 8 }, () => names.next())];
  nameOnly.forEach((name, i) => {
    const row = ready(
      { name, owner: "", phone: "", email: "", status: "", date: "", city: "", country: "" },
      i < 2 ? ["name_only", "same_name_no_city"] : ["name_only"],
    );
    row.nameOnly = true;
  });

  // ----- tricky text and hostile names, imported as text -----
  const zeroWidth = names.next();
  const tricky = [
    [{ name: names.reserve("Dupont, Fils & Cie") }, "quoted_comma"],
    [{ name: names.reserve("Le \"Petit\" Marché Gourmand") }, "quotes"],
    [{ name: names.next(), city: "Saint-Denis\nLa Plaine", country: "France" }, "newline_city"],
    [{ name: names.next().replace(" ", "\u00A0") }, "nbsp"],
    [{ name: zeroWidth.slice(0, 3) + "\u200B" + zeroWidth.slice(3) }, "zero_width"],
    [{ name: `\u202E${names.next()}` }, "bidi"],
    [{ name: `${names.next()}\u0007` }, "bell"],
    [{ name: names.reserve("Café ☕ Croissant \u{1F950}") }, "emoji"],
    [{ name: names.reserve("東京貿易 Trading") }, "cjk"],
    [{ name: names.reserve("Œnothèque Ångström Façade") }, "accents"],
    [{ name: names.reserve("'); drop table companies; --") }, "injection"],
    [{ name: names.reserve("),id.eq.") }, "injection"],
    [{ name: names.reserve("<img src=x onerror=alert(1)>") }, "xss"],
    [{ name: names.reserve("<script>alert(\"x\")</script>") }, "xss"],
    [{ name: names.reserve("=1+1 Négoce") }, "formula_name"],
    [{ name: names.reserve("'@Home Déco") }, "formula_name"],
    [{ name: names.reserve(`Comptoir des Saveurs ${"\u{1F370}".repeat(179)}`) }, "name_200_chars"],
    [{ name: `  ${names.next()}  ` }, "spaces"],
  ];
  for (const [fields, tag] of tricky) ready({ contact: "both", ...fields }, [tag]);
  const apostrophePhone = phones.frMobile();
  ready({ name: names.next(), phone: `'${formatPhone(apostrophePhone, "intl")}`, email: "" }, ["apostrophe_phone"]);

  // ----- generic importable rows up to 400 -----
  const readyCount = () => rows.filter((r) => r.label.expect === "ready").length;
  while (readyCount() < 400) {
    const roll = rnd.int(100);
    ready({ name: names.next(), contact: roll < 55 ? "both" : roll < 75 ? "email" : roll < 95 ? "phone" : "none" });
  }

  // ----- quotas on importable rows (exact counts from the design), then everything else -----
  const pooled = (field) => rows.filter((r) => r.label.expect === "ready" && !r.nameOnly && r.fields[field] === undefined);
  const fill = (field, specials, normal, tagFor) => {
    const targets = pooled(field);
    const values = [...specials];
    if (values.length > targets.length) throw new Error(`not enough rows for the ${field} quota`);
    while (values.length < targets.length) values.push(normal());
    rnd.shuffle(values).forEach((value, i) => {
      targets[i].fields[field] = value;
      const tag = tagFor(value);
      if (tag) targets[i].label.tags.push(tag);
    });
  };
  fill("status", [...Array(20).fill(""), ...Array(3).fill("Hot lead"), ...Array(2).fill("Prospect")], nextStatus, (v) =>
    v === "" ? "status_blank" : v === "Hot lead" ? "hot_lead" : v === "Prospect" ? "prospect" : null,
  );
  fill("owner", [...Array(30).fill(""), ...Array(6).fill("Former Rep")], nextOwner, (v) =>
    v === "" ? "owner_blank" : v === "Former Rep" ? "former_rep" : null,
  );
  fill("country", [...Array(15).fill(""), ...Array(2).fill("Atlantis")], () => nextCountry().label, (v) =>
    v === "" ? "country_blank" : v === "Atlantis" ? "atlantis" : null,
  );
  const specialDates = [
    ...Array(30).fill(""),
    ...Array.from({ length: 10 }, () => dates.ambiguous()),
    "30/03/2025 02:30",
    "29/03/2026 02:15",
    "2025-03-15T13:32:00Z",
    "2024-11-20T08:05:00.000Z",
    "45731",
    "45000.5",
  ];
  const dateTag = new Map([["30/03/2025 02:30", "dst_gap"], ["29/03/2026 02:15", "dst_gap"], ["2025-03-15T13:32:00Z", "iso_offset"],
    ["2024-11-20T08:05:00.000Z", "iso_offset"], ["45731", "excel_serial"], ["45000.5", "excel_serial"]]);
  const ambiguous = new Set(specialDates.slice(30, 40));
  fill("date", specialDates, () => dates.normal(), (v) => (v === "" ? "date_empty" : ambiguous.has(v) ? "ambiguous_date" : dateTag.get(v) ?? null));

  for (const row of rows) {
    const f = row.fields;
    f.owner ??= nextOwner();
    f.status ??= nextStatus();
    f.date ??= dates.normal();
    if (f.country === undefined) f.country = nextCountry().label;
    const code = codeOf(f.country);
    if (f.city === undefined) f.city = code ? rnd.pick(COUNTRIES[code].cities) : f.country === "Atlantis" ? "Poseidonia" : rnd.pick(ALL_CITIES);
    const contact = f.contact ?? "none";
    if (f.phone === undefined) f.phone = contact === "both" || contact === "phone" ? formatPhone(phones.forCountry(code ?? "FR"), rnd.pick(["national", "intl"])) : "";
    if (f.email === undefined) f.email = contact === "both" || contact === "email" ? email(f.name) : "";
    if (row.label.expect === "ready") {
      const fixes = [];
      if (f.owner === "Former Rep") fixes.push("owner_unassigned");
      if (f.country === "Atlantis") fixes.push("country_dropped");
      if (fixes.length) row.label.fixes = fixes;
    }
  }

  // ----- order: shuffle, then place each repeat after (or before) the row it depends on -----
  let order = rnd.shuffle(rows.filter((r) => !r.after && !r.before && r !== repeatsRejected));
  repeatsRejected.after = rejectedWithPhone;
  for (const row of rows.filter((r) => r.after || r.before)) {
    const at = order.indexOf(row.after ?? row.before);
    const index = row.after ? at + 1 + rnd.int(order.length - at) : rnd.int(at + 1);
    order.splice(index, 0, row);
  }
  // Three blank rows inside the data: ",,,,,,,", an empty line, spaces only.
  const blanks = [",,,,,,,", "", " , , "];
  [120, 260, 390].forEach((at, i) => order.splice(at, 0, { blank: blanks[i] }));
  let rowNo = 2;
  for (const item of order) item.row_no = rowNo++;

  const lines = [csvLine(HEADER, ",")];
  for (const item of order) {
    if (item.blank !== undefined) lines.push(item.blank);
    else {
      const f = item.fields;
      lines.push(csvLine([f.name, f.owner, f.phone, f.email, f.status, f.date, f.city, f.country, ...f.extra], ","));
    }
  }
  const sampleCsv = `${BOM}${lines.join("\r\n")}\r\n`;

  const expectedRows = order
    .filter((item) => item.blank === undefined)
    .map((item) => {
      const { expect, problems, fixes, match_key, tags } = item.label;
      const out = { row_no: item.row_no, expect };
      if (problems) out.problems = problems;
      if (fixes) out.fixes = fixes;
      if (match_key) out.match_key = match_key;
      if (item.after && expect === "duplicate_file") out.match_row_no = item.after.row_no;
      if (item.before) out.match_row_no = item.before.row_no;
      if (item.existing) out.match_existing_row_no = item.existing.row_no;
      if (tags.length) out.tags = tags;
      return out;
    });
  const count = (pred) => expectedRows.filter(pred).length;
  const tallyCodes = (key) => {
    const t = {};
    for (const r of expectedRows) for (const c of r[key] ?? []) t[c] = (t[c] ?? 0) + 1;
    return Object.fromEntries(Object.entries(t).sort());
  };
  const by = (expect) => Object.fromEntries(["email", "phone", "name"].map((k) => [k, count((r) => r.expect === expect && r.match_key === k)]));
  const fieldOnly = count((r) => r.expect === "rejected" && r.problems.every((p) => !["name_missing", "name_too_long", "columns_extra", "cell_too_long"].includes(p)));
  const expected = {
    file: "leads-500-fake.csv",
    generator: `scripts/make-fake-leads.mjs --seed ${seed}`,
    header: HEADER,
    delimiter: ",",
    encoding: "utf-8",
    row_count: expectedRows.length,
    last_row_no: rowNo - 1,
    blank_row_nos: order.filter((i) => i.blank !== undefined).map((i) => i.row_no),
    assumptions: {
      existing: "existing-20.csv is already in the CRM (imported first)",
      team: ["Haider Test", "Henri Test", "Kais Test"],
      status_choices: { "Hot lead": "warm", Prospect: "cold" },
      blank_status: "cold",
      date_order: "dmy",
      time_zone: "Europe/Paris",
      bad_field_policy: "reject_row",
    },
    totals: {
      ready: count((r) => r.expect === "ready"),
      duplicate_file: count((r) => r.expect === "duplicate_file"),
      duplicate_existing: count((r) => r.expect === "duplicate_existing"),
      rejected: count((r) => r.expect === "rejected"),
      ignored: 3,
      duplicate_file_by: by("duplicate_file"),
      duplicate_existing_by: by("duplicate_existing"),
      problems: tallyCodes("problems"),
      fixes: tallyCodes("fixes"),
    },
    // BAD_FIELD_POLICY = 'blank_field': bad emails, phones, dates and cities are dropped and the row comes in.
    blank_field_totals: {
      ready: count((r) => r.expect === "ready") + fieldOnly,
      duplicate_file: count((r) => r.expect === "duplicate_file"),
      duplicate_existing: count((r) => r.expect === "duplicate_existing"),
      rejected: count((r) => r.expect === "rejected") - fieldOnly,
    },
    rows: expectedRows,
  };

  const existingLines = [csvLine(HEADER, ",")];
  for (const e of existingOrder) {
    const f = e.fields;
    existingLines.push(csvLine([f.name, f.owner, f.phone, f.email, f.status, f.date, f.city, f.country], ","));
  }
  const existingCsv = `${BOM}${existingLines.join("\r\n")}\r\n`;

  return { sampleCsv, existingCsv, expected, frBytes: buildFrench(phones, emailSource(rnd, "fr")) };
}

// Windows-1252, ";" separator, French headers in another order plus "Notes" and "Chargé de compte" (the owner).
function buildFrench(phones, email) {
  const header = ["Ville", "Nom de la société", "Téléphone", "Chargé de compte", "E-mail", "Statut", "Pays", "Notes", "Dernière activité"];
  const names = [
    "Pâtisserie Hélène & Fils", "Crèmerie Aubépine Douce", "Brûlerie du Café Noël", "Tôlerie Mécanique Gaëlle",
    "Épicerie Fine Bœuf & Cie", "Chocolaterie Léonie Rose", "Fleuriste Rosée du Matin", "Boucherie Chéreau Père",
    "Distillerie Côte Bleue", "Maroquinerie Élodie Cuir", "Poissonnerie Île d’Yeu", "Vinothèque Château Grès",
    "Bonneterie Françoise Laine", "Mercerie Noémie & Cie", "Cordonnerie Zoé Talon", "Torréfaction Ébène Noire",
    "Fromagerie Gruyère d’Été", "Herboristerie Mélisse Verte", "Lunetterie Hervé Vision", "Bazar à 1 €",
  ];
  const places = [
    ["Besançon", "France"], ["Orléans", "France"], ["Nîmes", "France"], ["Chambéry", "France"], ["Liège", "Belgique"],
    ["Genève", "Suisse"], ["Fès", "Maroc"], ["Abidjan", "Côte d’Ivoire"], ["Luxembourg", "Luxembourg"], ["Créteil", "France"],
  ];
  const statuses = ["Froid", "Tiède (en cours)", "Négociation", "Client", "En pause", "Ne pas contacter", "Disqualifié"];
  const owners = ["Haider Test", "Henri Test", "Kais Test"];
  const notes = [
    "Livraison le mardi; paiement à 30 jours",
    "Préfère être appelé l’après-midi",
    "Remise de 5 % négociée",
    "« Très bon contact »",
    "Commande minimum : 200 €",
    "",
  ];
  const lines = [csvLine(header, ";")];
  names.forEach((name, i) => {
    const [city, country] = places[i % places.length];
    const day = 13 + (i % 15);
    const month = 1 + (i % 12);
    const date = i % 2 ? `${pad(day)}/${pad(month)}/2025 ${pad(9 + (i % 9))}:${pad((i * 7) % 60)}` : `${pad(day)}/${pad(month)}/2024`;
    lines.push(
      csvLine(
        [city, name, formatPhone(phones.frFixed(), i % 2 ? "national" : "intl"), owners[i % 3], email(name), statuses[i % 7], country, notes[i % notes.length], date],
        ";",
      ),
    );
  });
  return encodeWindows1252(`${lines.join("\r\n")}\r\n`);
}

// Large file for timing runs: every row importable and unique (unique emails; phones from a separate number range).
function buildPerf(seed, total) {
  const rnd = makeRandom(seed);
  const names = rnd.shuffle(PREFIXES.flatMap((p) => CORES.map((c) => `${p} ${c}`)));
  const phones = phoneSource(rnd, 1);
  const email = emailSource(rnd, "perf");
  const dates = dateSource(rnd);
  const lines = [csvLine(HEADER, ",")];
  for (let i = 0; i < total; i++) {
    const { code, label } = rnd.pick(COUNTRY_LABELS);
    const name = `${names[i % names.length]} ${i + 1}`;
    const phone = i < 10_000 ? formatPhone(i % 2 ? phones.frFixed() : phones.frMobile(), rnd.pick(["national", "intl"])) : "";
    lines.push(
      csvLine(
        [name, rnd.chance(0.1) ? "" : rnd.pick(OWNERS), phone, email(name), rnd.chance(0.08) ? "" : rnd.pick(STATUS_VARIANTS),
          rnd.chance(0.1) ? "" : dates.normal(), rnd.pick(COUNTRIES[code].cities), label],
        ",",
      ),
    );
  }
  return `${BOM}${lines.join("\r\n")}\r\n`;
}

// ---------- command line ----------

function parseArgs(argv) {
  const args = { seed: DEFAULT_SEED, rows: null, out: null, check: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === "--check") {
      args.check = true;
      continue;
    }
    if (flag === "--rows") args.rows = Number(value);
    else if (flag === "--out") args.out = value;
    else if (flag === "--seed") args.seed = Number(value);
    else throw new Error(`unknown option ${flag}`);
    i++;
  }
  if (!Number.isInteger(args.seed)) throw new Error("--seed needs a whole number");
  if (args.rows !== null && !(Number.isInteger(args.rows) && args.rows >= 1 && args.rows <= 200_000)) {
    throw new Error("--rows needs a whole number from 1 to 200000");
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.rows !== null) {
    if (!args.out) throw new Error("--rows needs --out DIR (a temporary folder: these files are never committed)");
    const out = path.resolve(args.out);
    if (out === FIXTURES || out.startsWith(`${FIXTURES}${path.sep}`)) throw new Error("perf files never go into tests/fixtures");
    mkdirSync(out, { recursive: true });
    const file = path.join(out, `leads-${args.rows}-perf.csv`);
    writeFileSync(file, buildPerf(args.seed, args.rows));
    console.log(`wrote ${file}`);
    return;
  }
  const { sampleCsv, existingCsv, expected, frBytes } = buildFixtures(args.seed);
  const files = {
    "leads-500-fake.csv": sampleCsv,
    "existing-20.csv": existingCsv,
    "leads-fr-20-cp1252.csv": frBytes,
    "not-a-csv.xlsx": Uint8Array.from([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode(" fake spreadsheet, not a real workbook ".padEnd(60, "."))]),
    "empty.csv": new Uint8Array(0),
    "expected.json": `${JSON.stringify(expected, null, 2)}\n`,
  };
  if (args.check) {
    const stale = Object.entries(files).filter(([name, content]) => {
      const file = path.join(FIXTURES, name);
      const want = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
      return !existsSync(file) || !readFileSync(file).equals(want);
    });
    for (const [name] of stale) console.error(`out of date: tests/fixtures/import/${name}`);
    process.exitCode = stale.length ? 1 : 0;
    if (!stale.length) console.log("fixtures match the generator");
    return;
  }
  mkdirSync(FIXTURES, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(FIXTURES, name), content);
  const t = expected.totals;
  console.log(
    `wrote ${Object.keys(files).length} files to ${path.relative(ROOT, FIXTURES)}: ready ${t.ready}, repeated ${t.duplicate_file}, ` +
      `already ${t.duplicate_existing}, rejected ${t.rejected}, last row ${expected.last_row_no}`,
  );
}

main();
