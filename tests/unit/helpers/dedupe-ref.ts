// A TypeScript copy of the SQL dedupe rules (design 2.1 and 3.8, shared contract) used only to check that the
// fixture labels in tests/fixtures/import/expected.json agree with them. The database stays the authority:
// tests/unit/key-rules.spec.ts runs one table of tricky names through this copy and checks that
// supabase/tests/import_attack.sql runs the very same table through private.lead_name_key, lead_email_key and
// lead_phone_key; it also checks the fold map and the legal forms below against the migration.
//
// lower() and the regex classes depend on the database's locale. This copy follows the Supabase Postgres 17 image (the
// CI database, and hosted projects on 17): ICU locale en-US, where lower() is the full Unicode lower-case mapping (as
// toLowerCase), [[:punct:]] is Unicode punctuation (P*), [[:space:]] the separators (Z*) and the space controls,
// [[:cntrl:]] the controls (Cc), and a word character ([[:alnum:]_]) a letter, a decimal digit or "_". A libc
// database (the local runner, C.UTF-8) also counts symbols such as + $ = and emoji as punctuation, so the shared table
// leaves those out.
import type { StagedRow } from "../../../src/lib/import/schema";

// private.lead_name_key's translate() map, character for character: Latin-1 Supplement and Latin Extended-A letters
// to ASCII (Æ æ Œ œ ß are replaced afterwards; × ÷ Þ þ Ĳ ĳ are kept).
export const FOLD_FROM =
  "ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝàáâãäåçèéêëìíîïðñòóôõöøùúûüýÿĀāĂă" +
  "ĄąĆćĈĉĊċČčĎďĐđĒēĔĕĖėĘęĚěĜĝĞğĠġĢģĤĥĦħĨĩĪīĬĭĮįİıĴĵĶķĸĹĺĻļĽľĿŀŁł" +
  "ŃńŅņŇňŉŊŋŌōŎŏŐőŔŕŖŗŘřŚśŜŝŞşŠšŢţŤťŦŧŨũŪūŬŭŮůŰűŲųŴŵŶŷŸŹźŻżŽžſ";
export const FOLD_TO =
  "AAAAAACEEEEIIIIDNOOOOOOUUUUYaaaaaaceeeeiiiidnoooooouuuuyyAaAa" +
  "AaCcCcCcCcDdDdEeEeEeEeEeGgGgGgGgHhHhIiIiIiIiIiJjKkkLlLlLlLlLl" +
  "NnNnNnnNnOoOoOoRrRrRrSsSsSsSsTtTtTtUuUuUuUuUuUuWwYyYZzZzZzs";
const FOLD_MAP = new Map(Array.from(FOLD_FROM, (c, i) => [c, FOLD_TO[i]]));

// The legal forms dropped as whole words, in the migration's order.
export const LEGAL_FORM_WORDS = [
  "sarl", "sas", "sasu", "sa", "eurl", "snc", "sci", "selarl", "ltd", "limited", "llc", "inc", "gmbh", "bv", "srl", "plc",
];
// \m(...)\M: a whole word, where a word character is a letter, a decimal digit or "_".
const LEGAL_FORMS = new RegExp(`(?<![\\p{L}\\p{Nd}_])(${LEGAL_FORM_WORDS.join("|")})(?![\\p{L}\\p{Nd}_])`, "gu");
// '[[:punct:][:space:][:cntrl:]\u00A0-\u00BF\u2000-\u206F]': with ICU, punctuation, separators and controls, plus the
// Latin-1 punctuation and symbols (U+00A0-U+00BF) and General Punctuation (U+2000-U+206F) ranges written out.
const PUNCTUATION = /[\p{P}\p{Z}\p{Cc}\u00A0-\u00BF\u2000-\u206F]/gu;

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
  const cityPart = city === null ? "" : fold(city).replace(PUNCTUATION, "");
  if (!cityPart) return null;
  const spaced = fold(name).replace(/\./g, "").replace(PUNCTUATION, " ");
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
