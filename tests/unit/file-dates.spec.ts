import { expect, test } from "@playwright/test";
import { createFormatter } from "use-intl/core";
import { fileDateLabel } from "@/lib/files/dates";

// Verifier 4d round 2 finding 12: whether a file's date shows its year is decided in next-intl's time zone, not the
// process's. 00:30 on 1 January in Paris is still 31 December in UTC (Vercel's server): a file added at 23:00 on
// 31 December, Paris time, is last year's for a Paris reader, whatever zone the process runs in.
const now = new Date("2026-12-31T23:30:00Z"); // 1 Jan 2027, 00:30 in Paris
const file = "2026-12-31T22:00:00Z"; // 31 Dec 2026, 23:00 in Paris

test("the year is judged in the configured time zone (Europe/Paris), not the runtime's", () => {
  const paris = createFormatter({ locale: "fr", timeZone: "Europe/Paris" });
  expect(fileDateLabel(paris, now, file)).toBe("31 déc. 2026");
  // The same instants read in UTC are the same year: no year. (The old check used Date#getFullYear, the process zone.)
  const utc = createFormatter({ locale: "fr", timeZone: "UTC" });
  expect(fileDateLabel(utc, now, file)).toBe("31 déc.");
});

test("this year's files show day and month; older ones the year too (EN and FR)", () => {
  const en = createFormatter({ locale: "en", timeZone: "Europe/Paris" });
  const today = new Date("2026-10-12T10:00:00Z");
  expect(fileDateLabel(en, today, "2026-03-04T10:00:00Z")).toBe("Mar 4");
  expect(fileDateLabel(en, today, "2025-03-04T10:00:00Z")).toBe("Mar 4, 2025");
  const fr = createFormatter({ locale: "fr", timeZone: "Europe/Paris" });
  expect(fileDateLabel(fr, today, "2026-03-04T10:00:00Z")).toBe("4 mars");
});
