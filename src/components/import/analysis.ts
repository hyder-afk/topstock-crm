// The matching screen's value lists (status words, owners, countries) and date-order guess, worked out once per file
// and column. The reading step prepares the columns the auto-match picks, one per task, so the screen only has to draw
// when it first shows (tens of thousands of rows otherwise make one long pause).
import {
  autoMap,
  countryKey,
  detectDateOrder,
  distinctValues,
  ownerKey,
  statusKey,
  type DateOrderGuess,
  type DistinctValue,
  type ParsedRecord,
} from "@/lib/import";

const cache = new WeakMap<readonly ParsedRecord[], Map<string, unknown>>();

function remember<T>(records: readonly ParsedRecord[], key: string, compute: () => T): T {
  let byKey = cache.get(records);
  if (!byKey) cache.set(records, (byKey = new Map()));
  if (!byKey.has(key)) byKey.set(key, compute());
  return byKey.get(key) as T;
}

const keyOf = { status: statusKey, owner: ownerKey, country: countryKey };

export function columnValues(records: readonly ParsedRecord[], column: number, kind: keyof typeof keyOf): DistinctValue[] {
  if (column < 0) return [];
  return remember(records, `${kind}:${column}`, () => distinctValues(records, column, keyOf[kind]));
}

export function columnDateOrder(records: readonly ParsedRecord[], column: number): DateOrderGuess | null {
  if (column < 0) return null;
  return remember(records, `date:${column}`, () => detectDateOrder(records.map((r) => r.cells[column])));
}

const NUMERIC_DATE = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})(?=$|[ T])/;

/** A date from the column to show both date orders with: one that reads either way (03/04/2025) when there is one. */
export function columnDateSample(records: readonly ParsedRecord[], column: number): string | null {
  if (column < 0) return null;
  return remember(records, `dateSample:${column}`, () => {
    let first: string | null = null;
    for (const record of records) {
      const m = NUMERIC_DATE.exec(record.cells[column]?.trim() ?? "");
      if (!m) continue;
      const a = Number(m[1]);
      const b = Number(m[3]);
      if (a >= 1 && a <= 12 && b >= 1 && b <= 12) return m[0];
      first ??= m[0];
    }
    return first;
  });
}

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Works out the lists for the columns the auto-match suggests, one per task. */
export async function prepareAnalysis(headers: readonly string[], records: readonly ParsedRecord[]): Promise<void> {
  const { targets } = autoMap(headers);
  for (const kind of ["status", "owner", "country"] as const) {
    await nextTask();
    columnValues(records, targets.indexOf(kind), kind);
  }
  await nextTask();
  columnDateOrder(records, targets.indexOf("last_activity"));
}
