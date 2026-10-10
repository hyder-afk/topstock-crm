// Column mapping (design 3.3): which column feeds which lead field. Mappings are arrays indexed by column, never
// objects keyed by header text.
import { cleanText, fold } from "./text";

export const FIELD_TARGETS = ["name", "owner", "phone", "email", "status", "last_activity", "city", "country"] as const;
export type FieldTarget = (typeof FIELD_TARGETS)[number];
export const TARGETS = [...FIELD_TARGETS, "ignore"] as const;
export type Target = (typeof TARGETS)[number];
export type ColumnMapping = readonly Target[];

/** NFD, accents removed, lower case, text in parentheses removed, punctuation turned into spaces. */
export function normaliseHeader(header: string): string {
  return fold(cleanText(header))
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Synonyms after normaliseHeader. Exact matches win over "contains" matches.
const SYNONYMS: ReadonlyArray<readonly [FieldTarget, readonly string[]]> = [
  [
    "name",
    [
      "company name",
      "company",
      "societe",
      "entreprise",
      "raison sociale",
      "nom de la societe",
      "nom de l entreprise",
      "nom societe",
      "account name",
      "name",
      "nom",
    ],
  ],
  ["owner", ["company owner", "owner", "lead owner", "contact owner", "proprietaire", "responsable", "commercial"]],
  ["phone", ["phone number", "phone", "telephone", "numero de telephone", "tel", "mobile"]],
  ["email", ["email", "e mail", "mail", "courriel", "email address", "adresse e mail", "adresse email"]],
  ["status", ["lead status", "status", "statut", "statut du lead"]],
  [
    "last_activity",
    ["last activity date", "last activity", "derniere activite", "date de derniere activite", "date derniere activite"],
  ],
  ["city", ["city", "ville"]],
  ["country", ["country region", "country", "pays", "region"]],
];

// Columns of a problems file (and similar) that are never imported, so a fixed file re-imports with no remapping.
const IGNORED = new Set(["row", "ligne", "problem", "probleme", "problems", "problemes"]);

function exactTarget(key: string): FieldTarget | "ignore" | null {
  if (IGNORED.has(key)) return "ignore";
  for (const [target, words] of SYNONYMS) if (words.includes(key)) return target;
  return null;
}

// "contains" match on whole words; the longest synonym wins (so "date de derniere activite client" is last_activity).
function containsTarget(key: string, taken: ReadonlySet<FieldTarget>): FieldTarget | null {
  const padded = ` ${key} `;
  let best: { target: FieldTarget; length: number } | null = null;
  for (const [target, words] of SYNONYMS) {
    if (taken.has(target)) continue;
    for (const word of words) {
      if (word.length > (best?.length ?? 0) && padded.includes(` ${word} `)) best = { target, length: word.length };
    }
  }
  return best?.target ?? null;
}

export type AutoMapping = {
  targets: Target[];
  /** True where the target was suggested (the "Matched" badge). */
  matched: boolean[];
};

/** Suggests a target per column: exact synonyms first, then "contains"; each field feeds from one column only. */
export function autoMap(headers: readonly string[]): AutoMapping {
  const keys = headers.map(normaliseHeader);
  const targets: Target[] = headers.map(() => "ignore");
  const matched = headers.map(() => false);
  const taken = new Set<FieldTarget>();
  const exact = keys.map(exactTarget);
  exact.forEach((target, i) => {
    if (target === "ignore") {
      matched[i] = true;
    } else if (target && !taken.has(target)) {
      targets[i] = target;
      matched[i] = true;
      taken.add(target);
    }
  });
  keys.forEach((key, i) => {
    // A second "Email" column stays "Don't import" rather than being matched to some other field.
    if (exact[i] !== null || key === "") return;
    const target = containsTarget(key, taken);
    if (target) {
      targets[i] = target;
      matched[i] = true;
      taken.add(target);
    }
  });
  return { targets, matched };
}

/** Gives `column` the target; a field already used by another column moves there in exchange (swap). */
export function assignTarget(mapping: ColumnMapping, column: number, target: Target): Target[] {
  const next = [...mapping];
  if (column < 0 || column >= next.length) return next;
  const previous = next[column];
  if (target !== "ignore") {
    const other = next.indexOf(target);
    if (other !== -1 && other !== column) next[other] = previous;
  }
  next[column] = target;
  return next;
}

/** Column index feeding the field, or -1. */
export function columnFor(mapping: ColumnMapping, field: FieldTarget): number {
  return mapping.indexOf(field);
}

/** Stable text for remembering a mapping per header row (the UI hashes it before using it as a storage key). */
export function headerFingerprint(headers: readonly string[]): string {
  return JSON.stringify(headers.map(normaliseHeader));
}
