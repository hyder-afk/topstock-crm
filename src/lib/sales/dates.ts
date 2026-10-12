// Hold dates (design 6.3 and D8): days are Europe/Paris calendar days, "YYYY-MM-DD", the end day included.

export const parisToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());

export function addDays(iso: string, n: number) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The new end of a hold after Extend: 14 more days from its end (or from today when it has ended), at most 90 days ahead. */
export function extendedUntil(holdUntil: string, today = parisToday()) {
  const from = holdUntil > today ? holdUntil : today;
  const next = addDays(from, 14);
  const cap = addDays(today, 90);
  return next > cap ? cap : next;
}
