// STATUS values (design 7.3): each distinct spelling is shown with its count; a known word maps to In Warehouse or In
// Transit, an unknown one must be chosen, and a blank cell uses the default chosen on the matching screen.
import { aliasKey } from "../import/text";
import { STOCK_STATUS_ALIASES, type LocationKind } from "./rules";

const ALIASES = new Map<string, LocationKind>(STOCK_STATUS_ALIASES);

/** The matching key of a STATUS cell ("" when blank). */
export function stockStatusKey(raw: string | null | undefined): string {
  return aliasKey(raw);
}

/** In Warehouse or In Transit for a known spelling, else null. */
export function suggestLocation(raw: string | null | undefined): LocationKind | null {
  return ALIASES.get(stockStatusKey(raw)) ?? null;
}

export type StatusValue = { key: string; label: string; count: number; suggested: LocationKind | null };

/** Distinct non-blank STATUS values of a column, most frequent first, with the first spelling seen as the label. */
export function distinctStatuses(cells: Iterable<string>): { values: StatusValue[]; blanks: number } {
  const byKey = new Map<string, StatusValue>();
  let blanks = 0;
  for (const raw of cells) {
    const key = stockStatusKey(raw);
    if (!key) {
      blanks++;
      continue;
    }
    const found = byKey.get(key);
    if (found) found.count++;
    else byKey.set(key, { key, label: raw.trim().slice(0, 80), count: 1, suggested: ALIASES.get(key) ?? null });
  }
  const values = [...byKey.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return { values, blanks };
}
