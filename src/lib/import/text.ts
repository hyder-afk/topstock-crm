// Text helpers shared by the import modules (design 3.5 "Every cell"). Pure: works in the browser and in Node.
import { FORMULA_START } from "./csv-out";

// Removed from every cell: C0 and C1 controls (tab and newlines are turned into spaces first), zero-width characters
// and joiners, the BOM, bidi marks, embeddings, overrides and isolates (U+061C, U+200E-F, U+202A-E, U+2066-9), the
// Mongolian vowel separator (U+180E), interlinear annotation marks (U+FFF9-B) and the invisible tag characters
// (U+E0000-U+E007F), so a name cannot hide text or reverse what follows it on screen.
export const INVISIBLE_CHARS =
  /[\u0000-\u001F\u007F-\u009F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/u;
const INVISIBLE_ALL = new RegExp(INVISIBLE_CHARS.source, "gu");
const NEWLINES = /\r\n|[\r\n\u0085\u2028\u2029]/g;
// Tab and every Unicode space separator (NBSP, narrow NBSP, figure and thin spaces, ideographic space...).
const SPACES = /[\t\p{Zs}]/gu;
const MULTI_SPACE = / {2,}/g;
const SURROGATE = /[\uD800-\uDFFF]/;

// Lone UTF-16 surrogates cannot be stored by Postgres; decoded files never contain them, but drop any defensively.
function dropLoneSurrogates(s: string): string {
  if (!SURROGATE.test(s)) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i] + s[i + 1];
        i++;
      }
    } else if (c < 0xdc00 || c > 0xdfff) {
      out += s[i];
    }
  }
  return out;
}

/**
 * The cell as it was before the problems file guarded it: csvCell puts one apostrophe in front of a cell that matches
 * FORMULA_START, so exactly that apostrophe is removed, from the cell as written (before any cleaning). Anything else,
 * "'abc" or "' text", is kept as it is.
 */
export function stripFormulaGuard(raw: string): string {
  return raw[0] === "'" && FORMULA_START.test(raw.slice(1)) ? raw.slice(1) : raw;
}

/** Cleans one cell without the placeholder rule: formula guard, NFC, spaces, invisible characters. */
export function cleanText(raw: string | undefined | null): string {
  if (!raw) return "";
  const s = dropLoneSurrogates(stripFormulaGuard(raw)).normalize("NFC");
  return s.replace(NEWLINES, " ").replace(SPACES, " ").replace(INVISIBLE_ALL, "").replace(MULTI_SPACE, " ").trim();
}

// Values that mean "nothing here" (compared after fold()).
export const PLACEHOLDERS: ReadonlySet<string> = new Set([
  "n/a",
  "#n/a",
  "na",
  "none",
  "null",
  "-",
  "--",
  "/",
  "?",
  "aucun",
  "neant",
  "inconnu",
  "unknown",
  "tbd",
]);

// Characters that show as nothing: the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), the soft hyphen and the blank
// braille pattern (U+2800). A cell made only of them (and spaces) looks empty, so it is empty: a lead name made of
// them is name_missing. The database only checks that a name is not empty, so this rule lives here.
const FILLER_ONLY = /^[ \u00AD\u115F\u1160\u2800\u3164\uFFA0]+$/;

/** cleanText plus the placeholder rule: "n/a", "-", "inconnu"... and blank-looking cells become empty. */
export function cleanCell(raw: string | undefined | null): string {
  const s = cleanText(raw);
  if (s.length > 0 && s.length <= 7 && PLACEHOLDERS.has(fold(s))) return "";
  if (FILLER_ONLY.test(s)) return "";
  return s;
}

const EXTRA_FOLD: ReadonlyArray<readonly [RegExp, string]> = [
  [/\u00DF/g, "ss"],
  [/\u00E6/g, "ae"],
  [/\u0153/g, "oe"],
  [/[\u0142\u0140]/g, "l"],
  [/\u00F8/g, "o"],
  [/[\u0111\u00F0]/g, "d"],
  [/\u0127/g, "h"],
  [/\u0131/g, "i"],
  [/\u0167/g, "t"],
];

/** Lower case without accents (NFD marks removed, plus ß, æ, œ, ł, ø, đ). For matching only, never stored. */
export function fold(s: string): string {
  let out = s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  if (/[^\u0000-\u007F]/.test(out)) for (const [re, to] of EXTRA_FOLD) out = out.replace(re, to);
  return out;
}

/** Matching key: cleaned, folded, every run of non-letters/digits turned into one space. */
export function aliasKey(raw: string | undefined | null): string {
  return fold(cleanText(raw))
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Characters as Postgres char_length counts them (code points, not UTF-16 units). */
export function codePointLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // A high surrogate followed by a low one is one character.
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/** True when the string is free of the characters cleanText removes and of lone surrogates. */
export function isCleanString(s: string): boolean {
  return !INVISIBLE_CHARS.test(s) && dropLoneSurrogates(s) === s;
}
