// A TypeScript copy of the SQL dedupe rules (design 2.1 and 3.8, shared contract) used only to check that the
// fixture labels in tests/fixtures/import/expected.json agree with them. The database stays the authority:
// tests/unit/key-rules.spec.ts runs one table of tricky names through this copy and checks that
// supabase/tests/import_attack.sql runs the very same table through private.lead_name_key, lead_email_key and
// lead_phone_key; it also checks the fold map, the two character sets and the legal forms below against the migration.
//
// The SQL name key gives the same result under any database locale (Supabase runs ICU, the local runner libc): it uses
// no character class, no word boundary and no lower() on Latin letters. The one step left to the locale is lower() on
// other scripts, where ICU, libc and toLowerCase() give the same letter, except that ICU and toLowerCase() write a
// Greek sigma at the end of a word as "ς" and libc as "σ"; both sides then turn "ς" into "σ". Only letters newer than
// one side's Unicode tables differ (Node 22 knows the Unicode 16 case pairs, such as U+A7CB; ICU 74 and glibc 2.39 not).
import type { StagedRow } from "../../../src/lib/import/schema";

// private.lead_name_key's translate() map, character for character: a-z, space, digits and "-" to themselves (only
// so that translate() finds them quickly), then A-Z and the Latin-1 Supplement and Latin Extended-A letters to
// lower-case ASCII (Æ æ Œ œ ß are replaced afterwards; × ÷ Þ þ Ĳ ĳ are kept).
export const FOLD_FROM =
  "abcdefghijklmnopqrstuvwxyz 0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ" +
  "ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝàáâãäåçèéêëìíîïðñòóôõöøùúûüýÿĀāĂă" +
  "ĄąĆćĈĉĊċČčĎďĐđĒēĔĕĖėĘęĚěĜĝĞğĠġĢģĤĥĦħĨĩĪīĬĭĮįİıĴĵĶķĸĹĺĻļĽľĿŀŁł" +
  "ŃńŅņŇňŉŊŋŌōŎŏŐőŔŕŖŗŘřŚśŜŝŞşŠšŢţŤťŦŧŨũŪūŬŭŮůŰűŲųŴŵŶŷŸŹźŻżŽžſ";
export const FOLD_TO =
  "abcdefghijklmnopqrstuvwxyz 0123456789-abcdefghijklmnopqrstuvwxyz" +
  "aaaaaaceeeeiiiidnoooooouuuuyaaaaaaceeeeiiiidnoooooouuuuyyaaaa" +
  "aaccccccccddddeeeeeeeeeegggggggghhhhiiiiiiiiiijjkkkllllllllll" +
  "nnnnnnnnnoooooorrrrrrssssssssttttttuuuuuuuuuuuuwwyyyzzzzzzs";
const FOLD_MAP = new Map(Array.from(FOLD_FROM, (c, i) => [c, FOLD_TO[i]]));

// private.lead_name_key's two character sets as code point ranges, in the migration's order (key-rules.spec.ts writes
// them out as the migration's escapes and checks that text is there).
export type CodeRange = readonly [first: number, last: number];
// glue: deleted from the name, as part of the word they sit in. Dots (S.A.R.L.), soft hyphen, combining accents (a
// decomposed "é"), zero-width space, non-joiner and joiner, word joiner, combining marks for symbols, combining half
// marks, byte order mark.
export const GLUE: readonly CodeRange[] = [
  [0x2e, 0x2e], [0xad, 0xad], [0x300, 0x36f], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200b, 0x200d], [0x2060, 0x2060],
  [0x20d0, 0x20ff], [0xfe20, 0xfe2f], [0xfeff, 0xfeff],
];
// punct: removed from the city, turned into spaces in the name. ASCII other than letters and digits (so "|" is always
// removed), C1 controls, Latin-1 punctuation and symbols, × ÷, the modifier apostrophe ʼ, combining accents, Greek
// punctuation, Arabic punctuation, the Ogham space, combining marks (extended and supplement), U+2000-U+2BFF (General
// Punctuation, super- and subscripts, currencies, letterlike symbols, number forms, arrows, maths, technical, enclosed
// alphanumerics, box drawing, shapes, dingbats, Braille, more arrows and symbols), Supplemental Punctuation, CJK
// symbols and punctuation (not 々 〆 〇, the Hangzhou numerals or the kana repeat marks), ゠ and ・, variation selectors
// to small form variants, the byte order mark, full-width punctuation and symbols, half-width CJK punctuation, the
// specials, emoji, flags and other pictographs (U+1F000-U+1FBFF), tag characters and supplementary variation selectors.
export const PUNCT: readonly CodeRange[] = [
  [0x01, 0x2f], [0x3a, 0x40], [0x5b, 0x60], [0x7b, 0xbf], [0xd7, 0xd7], [0xf7, 0xf7], [0x2bc, 0x2bc], [0x300, 0x36f],
  [0x37e, 0x37e], [0x384, 0x385], [0x387, 0x387], [0x60c, 0x60d], [0x61b, 0x61c], [0x61f, 0x61f], [0x66a, 0x66d],
  [0x6d4, 0x6d4], [0x1680, 0x1680], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x2000, 0x2bff], [0x2e00, 0x2e7f],
  [0x3000, 0x3004], [0x3008, 0x3020], [0x302a, 0x3030], [0x3036, 0x3037], [0x303d, 0x303f], [0x30a0, 0x30a0],
  [0x30fb, 0x30fb], [0xfe00, 0xfe6f], [0xfeff, 0xfeff], [0xff00, 0xff0f], [0xff1a, 0xff20], [0xff3b, 0xff40],
  [0xff5b, 0xff65], [0xffe0, 0xffff], [0x1f000, 0x1fbff], [0xe0000, 0xe007f], [0xe0100, 0xe01ef],
];

/** regexp_replace(s, '[...]', by, 'g') for a bracket of code point ranges. */
function replaceSet(s: string, set: readonly CodeRange[], by: string): string {
  return Array.from(s, (c) => {
    const cp = c.codePointAt(0)!;
    return set.some(([first, last]) => cp >= first && cp <= last) ? by : c;
  }).join("");
}

// The legal forms dropped as whole words, in the migration's order.
export const LEGAL_FORM_WORDS = [
  "sarl", "sas", "sasu", "sa", "eurl", "snc", "sci", "selarl", "ltd", "limited", "llc", "inc", "gmbh", "bv", "srl", "plc",
];
// ' (sarl|...)(?= )' on the name padded with spaces: a legal form with a space before and after it.
const LEGAL_FORMS = new RegExp(` (${LEGAL_FORM_WORDS.join("|")})(?= )`, "g");

/** lower(replace(...replace(translate(x, fold_from, fold_to), 'Œ', 'oe')..., 'ß', 'ss')), in the SQL order. */
function fold(s: string): string {
  const translated = Array.from(s, (c) => FOLD_MAP.get(c) ?? c).join("");
  return translated
    .replace(/Œ/g, "oe")
    .replace(/œ/g, "oe")
    .replace(/Æ/g, "ae")
    .replace(/æ/g, "ae")
    .replace(/ß/g, "ss")
    .toLowerCase();
}

/** nullif(lower(btrim(email)), '') */
export function emailKey(email: string | null): string | null {
  if (email === null) return null;
  const key = email.replace(/^ +| +$/g, "").toLowerCase();
  return key || null;
}

/** Digits only; null unless 8 to 15 digits; else the last 9 digits. */
export function phoneKey(phone: string | null): string | null {
  if (phone === null) return null;
  const digits = phone.replace(/[^0-9]/g, "");
  return digits.length < 8 || digits.length > 15 ? null : digits.slice(-9);
}

/** Folded name (legal forms removed unless that leaves nothing) | folded city | country; null without a city. */
export function nameKey(name: string, city: string | null, country: string | null): string | null {
  const cityPart = city === null ? "" : replaceSet(fold(city), PUNCT, "").replace(/ς/g, "σ");
  if (!cityPart) return null;
  const spaced = ` ${replaceSet(replaceSet(fold(name), GLUE, ""), PUNCT, " ").replace(/ς/g, "σ")} `;
  const stripped = spaced.replace(LEGAL_FORMS, " ");
  const namePart = (stripped.replace(/ /g, "") ? stripped : spaced).replace(/ /g, "");
  if (!namePart) return null;
  return `${namePart}|${cityPart}|${country ?? ""}`;
}

export type ExistingLead = { ref: number; email: string | null; phone: string | null; name: string; city: string | null; country: string | null };

export type DedupeResult =
  | { row_no: number; outcome: "rejected" | "ready" }
  | { row_no: number; outcome: "duplicate_existing"; match_key: "email" | "phone" | "name"; match_ref: number }
  | { row_no: number; outcome: "duplicate_file"; match_key: "email" | "phone" | "name"; match_row_no: number };

/**
 * Outcome per row, in the SQL order: rejected; already in the CRM by email, phone, then name (name only for rows with
 * no email and no phone key; the oldest lead wins, here the first in `existing`); repeated in the file by email, phone,
 * then name (keeper = first row of the name group with contact details, else the first row); else ready.
 */
export function dedupe(rows: ReadonlyArray<{ row_no: number; rejected: boolean; payload: unknown }>, existing: readonly ExistingLead[]): DedupeResult[] {
  const firstExisting = (key: (lead: ExistingLead) => string | null) => {
    const map = new Map<string, number>();
    for (const lead of existing) {
      const k = key(lead);
      if (k !== null && !map.has(k)) map.set(k, lead.ref);
    }
    return map;
  };
  const existingEmail = firstExisting((l) => emailKey(l.email));
  const existingPhone = firstExisting((l) => phoneKey(l.phone));
  const existingName = firstExisting((l) => nameKey(l.name, l.city, l.country));

  const staged = rows
    .filter((r) => !r.rejected)
    .map((r) => {
      const p = r.payload as StagedRow;
      const e = emailKey(p.email);
      const ph = phoneKey(p.phone);
      return { row_no: r.row_no, e, ph, n: nameKey(p.name, p.city, p.country), hasContact: e !== null || ph !== null };
    });
  const minBy = (key: (s: (typeof staged)[number]) => string | null, filter: (s: (typeof staged)[number]) => boolean = () => true) => {
    const map = new Map<string, number>();
    for (const s of staged) {
      const k = key(s);
      if (k !== null && filter(s) && !map.has(k)) map.set(k, s.row_no); // rows are in row_no order
    }
    return map;
  };
  const eKeep = minBy((s) => s.e);
  const pKeep = minBy((s) => s.ph);
  const nKeepContact = minBy((s) => s.n, (s) => s.hasContact);
  const nKeepAny = minBy((s) => s.n);
  const byRow = new Map(staged.map((s) => [s.row_no, s]));

  return rows.map((r): DedupeResult => {
    const s = byRow.get(r.row_no);
    if (!s) return { row_no: r.row_no, outcome: "rejected" };
    if (s.e !== null && existingEmail.has(s.e)) return { row_no: s.row_no, outcome: "duplicate_existing", match_key: "email", match_ref: existingEmail.get(s.e)! };
    if (s.ph !== null && existingPhone.has(s.ph)) return { row_no: s.row_no, outcome: "duplicate_existing", match_key: "phone", match_ref: existingPhone.get(s.ph)! };
    if (!s.hasContact && s.n !== null && existingName.has(s.n)) return { row_no: s.row_no, outcome: "duplicate_existing", match_key: "name", match_ref: existingName.get(s.n)! };
    if (s.e !== null && eKeep.get(s.e)! < s.row_no) return { row_no: s.row_no, outcome: "duplicate_file", match_key: "email", match_row_no: eKeep.get(s.e)! };
    if (s.ph !== null && pKeep.get(s.ph)! < s.row_no) return { row_no: s.row_no, outcome: "duplicate_file", match_key: "phone", match_row_no: pKeep.get(s.ph)! };
    if (!s.hasContact && s.n !== null) {
      const keeper = nKeepContact.get(s.n) ?? nKeepAny.get(s.n)!;
      if (keeper !== s.row_no) return { row_no: s.row_no, outcome: "duplicate_file", match_key: "name", match_row_no: keeper };
    }
    return { row_no: s.row_no, outcome: "ready" };
  });
}
