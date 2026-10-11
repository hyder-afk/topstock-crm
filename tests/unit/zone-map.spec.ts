import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { COUNTRY_CALL_ZONE, DEFAULT_CALL_ZONE, SPAN_ZONES, TZDATA_VERSION, ZONE_CHOICES } from "@/lib/zone-map.generated";

// The lead time-zone map exists twice (Day 4 design 5.1): src/lib/zone-map.generated.ts for the browser and the block
// between "-- zone-map:start" and "-- zone-map:end" in the Day 4b migration for the database. Both are written by
// scripts/make-zone-map.mjs; these tests read the migration text and fail when the two copies differ in any entry.
const sql = readFileSync(join(__dirname, "../../supabase/migrations/20261012090000_lead_page.sql"), "utf8");
const block = sql.slice(sql.indexOf("-- zone-map:start"), sql.indexOf("-- zone-map:end"));

// The "when 'XX' then ..." entries of one generated function, as a map from key to value text.
function entries(fn: string): Map<string, string> {
  const start = block.indexOf(`create function private.${fn}(`);
  expect(start, `${fn} is missing from the migration block`).toBeGreaterThanOrEqual(0);
  const body = block.slice(start, block.indexOf("$$;", start));
  const out = new Map<string, string>();
  for (const m of body.matchAll(/^ {4}when '([A-Z]{2})' then (.+)$/gm)) {
    expect(out.has(m[1]), `${fn} lists ${m[1]} twice`).toBe(false);
    out.set(m[1], m[2]);
  }
  return out;
}

const quoted = (text: string) => [...text.matchAll(/'([^']*)'/g)].map((m) => m[1]);

test("the migration block and the TypeScript map come from the same tzdata", () => {
  expect(block.length).toBeGreaterThan(0);
  expect(block).toContain(`from tzdata ${TZDATA_VERSION} `);
});

test("country calling zones are the same in SQL and TypeScript", () => {
  const fromSql = Object.fromEntries([...entries("country_call_zone")].map(([k, v]) => [k, quoted(v)[0]]));
  expect(fromSql).toEqual({ ...COUNTRY_CALL_ZONE });
  // France and the UK are exact; the US, Canada and Australia are called on whole-country hours until a zone is picked.
  expect(COUNTRY_CALL_ZONE.FR).toBe("Europe/Paris");
  expect(COUNTRY_CALL_ZONE.GB).toBe("Europe/London");
  expect(COUNTRY_CALL_ZONE.ES).toBe("Europe/Madrid");
  expect(COUNTRY_CALL_ZONE.PK).toBe("Asia/Karachi");
  for (const span of ["US", "CA", "AU", "MX", "BR", "ID"]) expect(COUNTRY_CALL_ZONE[span]).toBe(span);
  expect(COUNTRY_CALL_ZONE.AQ).toBeUndefined();
  expect(DEFAULT_CALL_ZONE).toBe("Europe/Paris");
  expect(sql).toContain("coalesce(p_zone, private.country_call_zone(p_country), 'Europe/Paris')");
});

test("zone choices are the same in SQL and TypeScript", () => {
  const fromSql = Object.fromEntries([...entries("country_zone_choices")].map(([k, v]) => [k, quoted(v)]));
  expect(fromSql).toEqual(Object.fromEntries(Object.entries(ZONE_CHOICES).map(([k, v]) => [k, [...v]])));
});

test("span ends are the same in SQL and TypeScript, eastern zone first", () => {
  const fromSql = Object.fromEntries([...entries("span_zones")].map(([k, v]) => [k, quoted(v)]));
  expect(fromSql).toEqual(Object.fromEntries(Object.entries(SPAN_ZONES).map(([k, v]) => [k, [...v]])));
  expect(SPAN_ZONES.US).toEqual(["America/New_York", "America/Los_Angeles"]);
  expect(SPAN_ZONES.ID).toEqual(["Asia/Jayapura", "Asia/Jakarta"]);
});

test("every span key has its two ends, and each country with choices offers its calling zone", () => {
  for (const [country, zone] of Object.entries(COUNTRY_CALL_ZONE)) {
    if (zone === country) {
      expect(SPAN_ZONES[country], `${country} is a span without ends`).toBeDefined();
      for (const end of SPAN_ZONES[country]) expect(ZONE_CHOICES[country]).toContain(end);
    } else if (ZONE_CHOICES[country]) {
      expect(ZONE_CHOICES[country]).toContain(zone);
    }
  }
  for (const country of Object.keys(SPAN_ZONES)) expect(COUNTRY_CALL_ZONE[country]).toBe(country);
  for (const country of Object.keys(ZONE_CHOICES)) expect(COUNTRY_CALL_ZONE[country]).toBeDefined();
});

test("every zone in the map formats in Intl (the browser can show it)", () => {
  const zones = new Set([
    ...Object.values(COUNTRY_CALL_ZONE).filter((z) => z.includes("/")),
    ...Object.values(ZONE_CHOICES).flat(),
    ...Object.values(SPAN_ZONES).flat(),
    DEFAULT_CALL_ZONE,
  ]);
  expect(zones.size).toBeGreaterThan(200);
  for (const zone of zones) {
    expect(() => new Intl.DateTimeFormat("en", { timeZone: zone, timeZoneName: "longGeneric" }).format(0), zone).not.toThrow();
  }
});

test("zone names are plain IANA names (the SQL block quotes them without escaping)", () => {
  for (const zone of [...Object.values(COUNTRY_CALL_ZONE), ...Object.values(ZONE_CHOICES).flat()]) {
    expect(zone).toMatch(/^([A-Z]{2}|[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){1,2})$/);
  }
});
