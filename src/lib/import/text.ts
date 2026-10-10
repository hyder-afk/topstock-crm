// Text helpers shared by the import modules (design 3.5 "Every cell"). Pure: works in the browser and in Node.

// Removed from every cell: C0 and C1 controls (tab and newlines are turned into spaces first), zero-width characters
// and joiners, the BOM, and bidi embeddings, overrides and isolates (U+202A-E, U+2066-9), so a name cannot hide text
// or reverse what follows it on screen.
export const INVISIBLE_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
const INVISIBLE_ALL = new RegExp(INVISIBLE_CHARS.source, "gu");
const NEWLINES = /\r\n|[\r\n\u0085\u2028\u2029]/g;
// Tab and every Unicode space separator (NBSP, narrow NBSP, figure and thin spaces, ideographic space...).
const SPACES = /[\t\p{Zs}]/gu;
const MULTI_SPACE = / {2,}/g;
const SURROGATE = /[\uD800-\uDFFF]/;
// One leading apostrophe that guards a formula (written by csvCell in the problems file) is removed again.
const QUOTE_GUARD = /^'(?=[ ]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]| )/;

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

/** Cleans one cell without the placeholder rule: NFC, spaces, invisible characters, one formula guard. */
export function cleanText(raw: string | undefined | null): string {
  if (!raw) return "";
  let s = dropLoneSurrogates(raw).normalize("NFC");
  s = s.replace(NEWLINES, " ").replace(SPACES, " ").replace(INVISIBLE_ALL, "").replace(MULTI_SPACE, " ").trim();
  if (QUOTE_GUARD.test(s)) s = s.slice(1).trim();
  return s;
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

/** cleanText plus the placeholder rule: "n/a", "-", "inconnu"... become empty. */
export function cleanCell(raw: string | undefined | null): string {
  const s = cleanText(raw);
  if (s.length > 0 && s.length <= 7 && PLACEHOLDERS.has(fold(s))) return "";
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
