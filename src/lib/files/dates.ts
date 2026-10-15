import type { useFormatter } from "next-intl";

type Format = Pick<ReturnType<typeof useFormatter>, "dateTime">;

/** A file's date on its row: "12 oct." this year, "12 oct. 2025" before. Both years are read through next-intl's
 *  formatter, so in its configured time zone (Europe/Paris), never the process's: the server (UTC on Vercel) and the
 *  browser then agree around New Year and the row hydrates without a text mismatch (verifier 4d round 2 finding 12). */
export function fileDateLabel(format: Format, now: Date, iso: string) {
  const d = new Date(iso);
  const year = (x: Date) => format.dateTime(x, { year: "numeric" });
  return format.dateTime(d, year(d) === year(now) ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}
