// Value mapping (design 3.4): status words, owner names, countries and the date order. Lookups use Map objects and
// matching keys, never plain objects keyed by sheet text.
import { countryCodes } from "../countries";
import type { ParsedRecord } from "./parse";
import { STATUS_ALIASES, type LeadStatus } from "./rules";
import { aliasKey, cleanCell } from "./text";

// ---------- Status ----------

const STATUS_BY_KEY: ReadonlyMap<string, LeadStatus> = new Map(STATUS_ALIASES);

/** Key that groups status spellings ("Cool-off", "cool off", "COOL OFF" are one entry). Empty for a blank cell. */
export function statusKey(raw: string | null | undefined): string {
  return aliasKey(cleanCell(raw));
}

/** Suggested status for a sheet word, or null when the word needs an explicit choice. */
export function suggestStatus(raw: string | null | undefined): LeadStatus | null {
  const key = statusKey(raw);
  return key ? (STATUS_BY_KEY.get(key) ?? null) : null;
}

// ---------- Owner ----------

export type TeamMemberLite = { id: string; first_name: string | null; last_name: string | null };

export function ownerKey(raw: string | null | undefined): string {
  return aliasKey(cleanCell(raw));
}

function addTo(map: Map<string, string[]>, key: string, id: string) {
  if (!key) return;
  const list = map.get(key);
  if (list) list.push(id);
  else map.set(key, [id]);
}

/**
 * Matches sheet owner names to CRM users: full name "first last", then "last first", then a first name that only one
 * user has, all without accents or case. Anything else (unknown or ambiguous) gives null: the lead comes in unassigned.
 */
export function createOwnerMatcher(team: readonly TeamMemberLite[]): (raw: string | null | undefined) => string | null {
  const full = new Map<string, string[]>();
  const reversed = new Map<string, string[]>();
  const first = new Map<string, string[]>();
  for (const member of team) {
    const f = aliasKey(member.first_name);
    const l = aliasKey(member.last_name);
    addTo(full, [f, l].filter(Boolean).join(" "), member.id);
    if (f && l) addTo(reversed, `${l} ${f}`, member.id);
    addTo(first, f, member.id);
  }
  return (raw) => {
    const key = ownerKey(raw);
    if (!key) return null;
    for (const map of [full, reversed]) {
      const ids = map.get(key);
      if (ids) return ids.length === 1 ? ids[0] : null;
    }
    const ids = first.get(key);
    return ids && ids.length === 1 ? ids[0] : null;
  };
}

export function matchOwner(raw: string | null | undefined, team: readonly TeamMemberLite[]): string | null {
  return createOwnerMatcher(team)(raw);
}

// ---------- Country ----------

// Common names Intl.DisplayNames (en, fr) does not give.
export const COUNTRY_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["UK", "GB"],
  ["England", "GB"],
  ["Scotland", "GB"],
  ["Wales", "GB"],
  ["Northern Ireland", "GB"],
  ["Great Britain", "GB"],
  ["Grande-Bretagne", "GB"],
  ["Angleterre", "GB"],
  ["USA", "US"],
  ["US", "US"],
  ["U.S.A.", "US"],
  ["United States of America", "US"],
  ["États-Unis", "US"],
  ["Holland", "NL"],
  ["Pays-Bas", "NL"],
  ["Deutschland", "DE"],
  ["España", "ES"],
  ["Italia", "IT"],
  ["België", "BE"],
  ["Belgie", "BE"],
  ["Schweiz", "CH"],
  ["Türkiye", "TR"],
  ["Turkey", "TR"],
  ["UAE", "AE"],
  ["Czech Republic", "CZ"],
  ["Ivory Coast", "CI"],
  // Intl gives "Hong Kong SAR China", "Myanmar (Burma)", "Eswatini", "Palestinian Territories"...
  ["Hong Kong", "HK"],
  ["Macau", "MO"],
  ["Macao", "MO"],
  ["The Netherlands", "NL"],
  ["Korea", "KR"],
  ["South Korea", "KR"],
  ["Republic of Korea", "KR"],
  ["Corée", "KR"],
  ["Burma", "MM"],
  ["Myanmar", "MM"],
  ["Birmanie", "MM"],
  ["Swaziland", "SZ"],
  ["Macedonia", "MK"],
  ["North Macedonia", "MK"],
  ["Macédoine", "MK"],
  ["Palestine", "PS"],
  ["State of Palestine", "PS"],
];

let countryIndex: Map<string, string> | null = null;

function getCountryIndex(): Map<string, string> {
  if (countryIndex) return countryIndex;
  const index = new Map<string, string>();
  const add = (name: string | undefined, code: string) => {
    const key = aliasKey(name);
    if (key && !index.has(key)) index.set(key, code);
  };
  for (const [name, code] of COUNTRY_ALIASES) add(name, code);
  for (const code of countryCodes) add(code, code);
  for (const locale of ["en", "fr"]) {
    const names = new Intl.DisplayNames([locale], { type: "region", fallback: "none" });
    for (const code of countryCodes) {
      try {
        add(names.of(code), code);
      } catch {
        // an engine without data for this region: the code and aliases still match
      }
    }
  }
  countryIndex = index;
  return index;
}

export function countryKey(raw: string | null | undefined): string {
  return aliasKey(cleanCell(raw));
}

/** ISO code for a country written as a code, an English or French name, or a common alias; else null. */
export function matchCountry(raw: string | null | undefined): string | null {
  const key = countryKey(raw);
  return key ? (getCountryIndex().get(key) ?? null) : null;
}

// ---------- Date order ----------

export type DateOrder = "dmy" | "mdy";
export type DateOrderGuess = {
  order: DateOrder | "ambiguous" | "mixed";
  /** Cells whose first part is above 12 (day first). */
  dmy: number;
  /** Cells whose second part is above 12 (month first). */
  mdy: number;
  /** Cells that read either way, like 03/04/2025. */
  ambiguous: number;
};

const NUMERIC_DATE = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})(?:$|[ T])/;

/** Scans a whole date column: day above 12 first means DMY, second part above 12 means MDY, both means mixed. */
export function detectDateOrder(values: Iterable<string | null | undefined>): DateOrderGuess {
  let dmy = 0;
  let mdy = 0;
  let ambiguous = 0;
  for (const raw of values) {
    const m = NUMERIC_DATE.exec(cleanCell(raw));
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[3]);
    if (a > 12 && a <= 31 && b >= 1 && b <= 12) dmy++;
    else if (b > 12 && b <= 31 && a >= 1 && a <= 12) mdy++;
    else if (a >= 1 && a <= 12 && b >= 1 && b <= 12) ambiguous++;
  }
  const order = dmy && mdy ? "mixed" : dmy ? "dmy" : mdy ? "mdy" : "ambiguous";
  return { order, dmy, mdy, ambiguous };
}

/** The order preselected in the UI: MDY only when the column clearly is; DD/MM otherwise (also for "mixed"). */
export function suggestDateOrder(guess: DateOrderGuess): DateOrder {
  return guess.order === "mdy" ? "mdy" : "dmy";
}

// ---------- Distinct values of a column (the "Values to check" lists) ----------

export type DistinctValue = { key: string; label: string; count: number };

/** Every distinct non-blank value of a column by key, most frequent first; `label` is the first spelling seen. */
export function distinctValues(
  records: readonly ParsedRecord[],
  column: number,
  keyOf: (raw: string) => string = statusKey,
): DistinctValue[] {
  const seen = new Map<string, DistinctValue>();
  if (column < 0) return [];
  for (const record of records) {
    const raw = record.cells[column] ?? "";
    const key = keyOf(raw);
    if (!key) continue;
    const entry = seen.get(key);
    if (entry) entry.count++;
    else seen.set(key, { key, label: cleanCell(raw), count: 1 });
  }
  return [...seen.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
