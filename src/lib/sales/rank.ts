// Ordering of the sale, hold and request pickers' results (pure, unit-tested).

/** The search matches words anywhere; the names that start with (then contain) what was typed come first, so Enter
 * picks the product the person meant. */
export function rankByName<T extends { name: string }>(rows: T[], q: string): T[] {
  const needle = q.trim().toLocaleLowerCase();
  if (!needle) return rows;
  const rank = (name: string) => {
    const n = name.toLocaleLowerCase();
    return n.startsWith(needle) ? 0 : n.includes(needle) ? 1 : 2;
  };
  return rows.map((r, i) => ({ r, i, k: rank(r.name) })).sort((a, b) => a.k - b.k || a.i - b.i).map((x) => x.r);
}
