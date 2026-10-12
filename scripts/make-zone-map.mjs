#!/usr/bin/env node
// The lead time-zone map, written twice from one source (Day 4 design section 5.1): a TypeScript copy for the browser
// (src/lib/zone-map.generated.ts) and a SQL copy for the database (the block between "-- zone-map:start" and
// "-- zone-map:end" in the Day 4b migration). tests/unit/zone-map.spec.ts checks that the two copies agree.
//
// Source: the system time zone database (/usr/share/zoneinfo: zone.tab lists each country's zones, zone1970.tab is the
// cross-check), the same files PostgreSQL reads (it is built --with-system-tzdata), plus the reviewed choices in
// scripts/zone-map.overrides.json. UTC offsets are read with GNU date from those same files, not from Node's own copy of
// the database (ICU), which can be older: for example ICU 2025b still puts British Columbia on winter time from November
// 2026, tzdata 2026c does not.
//
// Rules:
//  - a country whose zones all keep the same UTC offsets (at five instants from Nov 2026 to Oct 2027) is called on one
//    zone: "main" from the overrides, or its first zone.tab zone. Nobody picks a zone for its leads;
//  - a country whose zones differ needs a span in the overrides (called only while both ends are in office hours; the
//    key is the country code) or a main zone, else the script stops. Its leads may get a zone picked from a closed list:
//    "choices" from the overrides, or one zone per distinct offset (the main zone or span ends first in their group);
//  - "noZone" countries (nobody to call) get no zone: their leads use the default zone, like a lead with no country.
// Every zone written must exist in the system database and in Node's Intl (the browser formats it), else the script
// stops. Zone names are checked against a strict pattern before they go into SQL.
//
//   node scripts/make-zone-map.mjs           writes both copies
//   node scripts/make-zone-map.mjs --check   exits 1 when either copy differs from what it would write

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ZONEINFO = "/usr/share/zoneinfo";
const OVERRIDES = path.join(ROOT, "scripts", "zone-map.overrides.json");
const TS_OUT = path.join(ROOT, "src", "lib", "zone-map.generated.ts");
const SQL_OUT = path.join(ROOT, "supabase", "migrations", "20261012090000_lead_page.sql");
const START = "-- zone-map:start";
const END = "-- zone-map:end";
// Instants at which offsets are compared (noon UTC, mid-month, winter and summer on both hemispheres).
const INSTANTS = ["2026-11-15", "2027-01-15", "2027-04-15", "2027-07-15", "2027-10-15"].map((d) => Date.parse(`${d}T12:00:00Z`) / 1000);
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){1,2}$/;
const COUNTRY = /^[A-Z]{2}$/;

function fail(message) {
  console.error(`make-zone-map: ${message}`);
  process.exit(1);
}

function readTab(name) {
  return readFileSync(path.join(ZONEINFO, name), "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split("\t"));
}

function tzdataVersion() {
  const zi = path.join(ZONEINFO, "tzdata.zi");
  const first = existsSync(zi) ? readFileSync(zi, "utf8").split("\n", 1)[0] : "";
  const match = /^# version (\S+)$/.exec(first);
  if (!match) fail("cannot read the tzdata version from tzdata.zi");
  return match[1];
}

// Offsets in minutes east of UTC at INSTANTS, from the system files (GNU date; an unknown TZ would silently be UTC, so
// the file is checked first).
const offsetCache = new Map();
function offsets(zone) {
  if (!offsetCache.has(zone)) {
    if (!ZONE_NAME.test(zone)) fail(`unexpected zone name ${JSON.stringify(zone)}`);
    if (!existsSync(path.join(ZONEINFO, zone))) fail(`${zone} is not in ${ZONEINFO}`);
    const out = execFileSync("date", ["-f", "-", "+%z"], {
      input: INSTANTS.map((s) => `@${s}`).join("\n") + "\n",
      env: { TZ: zone, PATH: process.env.PATH },
      encoding: "utf8",
    });
    const list = out.trim().split("\n").map((z) => {
      const m = /^([+-])(\d\d)(\d\d)$/.exec(z);
      if (!m) fail(`date gave ${JSON.stringify(z)} for ${zone}`);
      return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
    });
    if (list.length !== INSTANTS.length) fail(`date gave ${list.length} offsets for ${zone}`);
    offsetCache.set(zone, list);
  }
  return offsetCache.get(zone);
}

function intlKnows(zone) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function build() {
  const overrides = JSON.parse(readFileSync(OVERRIDES, "utf8"));
  const known = new Set(["$comment", "spans", "main", "choices", "noZone"]);
  for (const key of Object.keys(overrides)) if (!known.has(key)) fail(`unknown key "${key}" in the overrides`);
  const spans = overrides.spans ?? {};
  const main = overrides.main ?? {};
  const choicesOverride = overrides.choices ?? {};
  const noZone = new Set(overrides.noZone ?? []);

  // Country -> zones, in zone.tab order.
  const byCountry = new Map();
  for (const [code, , zone] of readTab("zone.tab")) {
    if (!COUNTRY.test(code)) fail(`unexpected country code ${JSON.stringify(code)} in zone.tab`);
    if (!byCountry.has(code)) byCountry.set(code, []);
    byCountry.get(code).push(zone);
  }
  // Cross-check: zone1970.tab names the same countries, and each of its zones exists.
  const countries1970 = new Set();
  for (const [codes, , zone] of readTab("zone1970.tab")) {
    for (const code of codes.split(",")) countries1970.add(code);
    offsets(zone);
  }
  for (const code of byCountry.keys()) if (!countries1970.has(code)) fail(`${code} is in zone.tab but not in zone1970.tab`);
  for (const code of countries1970) if (!byCountry.has(code)) fail(`${code} is in zone1970.tab but not in zone.tab`);
  for (const group of [spans, main, choicesOverride]) {
    for (const code of Object.keys(group)) if (!byCountry.has(code)) fail(`override for unknown country ${code}`);
  }
  for (const code of noZone) if (!byCountry.has(code)) fail(`noZone lists unknown country ${code}`);

  const callZone = {};
  const zoneChoices = {};
  const spanZones = {};
  for (const code of [...byCountry.keys()].sort()) {
    const zones = byCountry.get(code);
    const own = (zone, what) => {
      if (!zones.includes(zone)) fail(`${what} ${zone} is not one of ${code}'s zones in zone.tab`);
      return zone;
    };
    // Distinct offset patterns, in zone.tab order of their first zone.
    const groups = new Map();
    for (const zone of zones) {
      const key = offsets(zone).join(",");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(zone);
    }
    if (noZone.has(code)) {
      if (spans[code] || main[code] || choicesOverride[code]) fail(`${code} is noZone and also has other overrides`);
      continue;
    }
    if (spans[code] && main[code]) fail(`${code} has both a span and a main zone`);
    if (groups.size === 1) {
      if (spans[code] || choicesOverride[code]) fail(`${code} has one offset: it takes no span and no choices`);
      callZone[code] = main[code] ? own(main[code], "main zone") : zones[0];
      continue;
    }
    let preferred;
    if (spans[code]) {
      const ends = spans[code];
      if (!Array.isArray(ends) || ends.length !== 2) fail(`${code}'s span needs exactly two zones`);
      ends.forEach((zone) => own(zone, "span end"));
      const [east, west] = ends.map(offsets);
      if (!east.every((o, i) => o > west[i])) fail(`${code}'s span must name its eastern zone first`);
      callZone[code] = code;
      spanZones[code] = [ends[0], ends[1]];
      preferred = new Set(ends);
    } else if (main[code]) {
      callZone[code] = own(main[code], "main zone");
      preferred = new Set([main[code]]);
    } else {
      fail(`${code} has zones with different offsets (${[...groups.values()].map((g) => g[0]).join(", ")}): add a span or a main zone`);
    }
    let choices;
    if (choicesOverride[code]) {
      choices = choicesOverride[code].map((zone) => own(zone, "choice"));
      if (new Set(choices).size !== choices.length) fail(`${code}'s choices repeat a zone`);
    } else {
      // One zone per distinct offset; the group of the main zone (or of the span ends) first.
      const ordered = [...groups.values()].sort(
        (a, b) => Number(b.some((zone) => preferred.has(zone))) - Number(a.some((zone) => preferred.has(zone))));
      choices = ordered.map((group) => group.find((zone) => preferred.has(zone)) ?? group[0]);
    }
    for (const zone of preferred) if (!choices.includes(zone)) fail(`${code}'s choices must include ${zone}`);
    zoneChoices[code] = choices;
  }

  const written = new Set([
    ...Object.values(callZone).filter((z) => !COUNTRY.test(z)),
    ...Object.values(zoneChoices).flat(),
    ...Object.values(spanZones).flat(),
  ]);
  for (const zone of written) {
    offsets(zone);
    if (!intlKnows(zone)) fail(`Node's Intl does not know ${zone}: the browser could not show it`);
  }
  return { version: tzdataVersion(), callZone, zoneChoices, spanZones };
}

function tsText({ version, callZone, zoneChoices, spanZones }) {
  const q = (s) => JSON.stringify(s);
  const lines = [
    "// Generated by scripts/make-zone-map.mjs from the system time zone database (zone.tab) and",
    "// scripts/zone-map.overrides.json. Do not edit by hand: change the overrides, run `node scripts/make-zone-map.mjs`",
    "// and commit this file with the migration block it also writes (tests/unit/zone-map.spec.ts compares the two).",
    "",
    `export const TZDATA_VERSION = ${q(version)};`,
    "",
    "/** A lead with no country (or a country with nobody to call) is called on this zone. */",
    'export const DEFAULT_CALL_ZONE = "Europe/Paris";',
    "",
    "/** Each country's calling zone: an IANA zone, or a span key (the country code) called on whole-country hours. */",
    "export const COUNTRY_CALL_ZONE: Readonly<Record<string, string>> = {",
    ...Object.entries(callZone).map(([k, v]) => `  ${k}: ${q(v)},`),
    "};",
    "",
    "/** The closed list of zones a person may pick for a lead, per country with several zones. */",
    "export const ZONE_CHOICES: Readonly<Record<string, readonly string[]>> = {",
    ...Object.entries(zoneChoices).map(([k, v]) => `  ${k}: [${v.map(q).join(", ")}],`),
    "};",
    "",
    "/** Span keys: [eastern zone, western zone]; a span lead is in hours only while both are. */",
    "export const SPAN_ZONES: Readonly<Record<string, readonly [string, string]>> = {",
    ...Object.entries(spanZones).map(([k, v]) => `  ${k}: [${v.map(q).join(", ")}],`),
    "};",
    "",
  ];
  return lines.join("\n");
}

function sqlBlock({ version, callZone, zoneChoices, spanZones }) {
  const q = (s) => `'${s}'`;  // names are checked against ZONE_NAME / COUNTRY: no quote can appear
  const arr = (list) => `array[${list.map(q).join(", ")}]`;
  const fn = (name, arg, returns, comment, entries) => [
    `-- ${comment}`,
    `create function private.${name}(${arg} text) returns ${returns}`,
    "language plpgsql immutable parallel safe set search_path = '' as $$",
    "begin",
    `  return case ${arg}`,
    ...entries.map(([k, v]) => `    when ${q(k)} then ${v}`),
    "  end;",
    "end;",
    "$$;",
  ];
  return [
    `${START} (generated by scripts/make-zone-map.mjs from tzdata ${version} and scripts/zone-map.overrides.json; do not`,
    "-- edit by hand: tests/unit/zone-map.spec.ts compares this block with src/lib/zone-map.generated.ts)",
    ...fn("country_call_zone", "p_country", "text",
      "Each country's calling zone: an IANA zone, or a span key (the country code); null for no country or nobody to call.",
      Object.entries(callZone).map(([k, v]) => [k, q(v)])),
    "",
    ...fn("country_zone_choices", "p_country", "text[]",
      "The closed list of zones a person may pick for a lead, per country with several zones; null for the others.",
      Object.entries(zoneChoices).map(([k, v]) => [k, arr(v)])),
    "",
    ...fn("span_zones", "p_key", "text[]",
      "A span key's two ends, eastern zone first; null for a plain zone.",
      Object.entries(spanZones).map(([k, v]) => [k, arr(v)])),
    END,
  ].join("\n");
}

const map = build();
const check = process.argv.includes("--check");
const ts = tsText(map);
const sql = readFileSync(SQL_OUT, "utf8");
const from = sql.indexOf(START);
const to = sql.indexOf(END);
if (from < 0 || to < from || sql.indexOf(START, from + 1) >= 0) fail(`markers ${START} / ${END} not found once in ${SQL_OUT}`);
const newSql = sql.slice(0, from) + sqlBlock(map) + sql.slice(to + END.length);
if (check) {
  const tsSame = existsSync(TS_OUT) && readFileSync(TS_OUT, "utf8") === ts;
  const sqlSame = newSql === sql;
  if (!tsSame || !sqlSame) {
    console.error(`make-zone-map: out of date: ${[!tsSame && TS_OUT, !sqlSame && SQL_OUT].filter(Boolean).join(", ")}`);
    process.exit(1);
  }
  console.log("make-zone-map: both copies are up to date");
} else {
  writeFileSync(TS_OUT, ts);
  writeFileSync(SQL_OUT, newSql);
  const multi = Object.keys(map.zoneChoices).length;
  console.log(`make-zone-map: tzdata ${map.version}, ${Object.keys(map.callZone).length} countries, ${multi} with zone choices, ` +
    `${Object.keys(map.spanZones).length} spans`);
}
