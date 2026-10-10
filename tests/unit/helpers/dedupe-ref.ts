// A TypeScript copy of the SQL dedupe rules (design 2.1 and 3.8, shared contract) used only to check that the
// fixture labels in tests/fixtures/import/expected.json agree with them. The database stays the authority; the
// builder's parity spec compares these rules with the migration once it lands.
import type { StagedRow } from "../../../src/lib/import/schema";

const LEGAL_FORMS = /(?<![\p{L}\p{N}_])(sarl|sas|sasu|sa|eurl|snc|sci|selarl|ltd|limited|llc|inc|gmbh|bv|srl|plc)(?![\p{L}\p{N}_])/gu;
// ASCII punctuation, spaces and controls, Latin-1 punctuation (U+00A0-U+00BF), General Punctuation (U+2000-U+206F).
const PUNCTUATION = /[\u0000-/:-@[-`{-\u007F\u00A0-¿\u2000-\u206F]/gu;

// lower(translate(x, Latin-1 Supplement + Latin Extended-A -> ASCII)), then oe, ae, ss. Only letters of those two
// blocks lose their accents; other scripts are kept as they are.
// Letters of those blocks that have no decomposition.
const NO_DECOMPOSITION = new Map([
  ["Ł", "L"], ["ł", "l"], ["Ø", "O"], ["ø", "o"], ["Đ", "D"], ["đ", "d"], ["Ð", "D"],
  ["ð", "d"], ["Ħ", "H"], ["ħ", "h"], ["ı", "i"], ["Ŧ", "T"], ["ŧ", "t"], ["Ŀ", "L"],
  ["ŀ", "l"], ["ĸ", "k"], ["Ŋ", "N"], ["ŋ", "n"],
]);

function fold(s: string): string {
  const translated = Array.from(s, (c) => {
    const code = c.codePointAt(0)!;
    if (code < 0xc0 || code > 0x17f) return c;
    return NO_DECOMPOSITION.get(c) ?? c.normalize("NFD").replace(/\p{M}/gu, "");
  }).join("");
  return translated.toLowerCase().replace(/œ/g, "oe").replace(/æ/g, "ae").replace(/ß/g, "ss");
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
