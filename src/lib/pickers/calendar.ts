// Pure date rules behind the app's own date pickers (no native date input, Haider 15 Oct 2026). A day is always a
// "YYYY-MM-DD" string, the same shape <input type="date"> gave, so server actions and Zod schemas do not change.
// Arithmetic runs in UTC, so no daylight-saving change or browser zone can shift a day.

import { isTime } from "./time";

export type IsoDate = string; // "YYYY-MM-DD"
export type WeekStart = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday, 1 = Monday (the default here: France and the EU)

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day as numbers (month 1-12), or null for anything else ("2026-02-30", "", "15/10/2026"). */
export function parseIsoDate(value: string | null | undefined): { y: number; m: number; d: number } | null {
  if (!value) return null;
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

export function isIsoDate(value: string | null | undefined): value is IsoDate {
  return parseIsoDate(value) !== null;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function toIsoDate(y: number, m: number, d: number): IsoDate {
  const date = new Date(Date.UTC(y, m - 1, d));
  // Date.UTC treats years 0-99 as 1900-1999; set the full year again so every year round-trips.
  date.setUTCFullYear(y, m - 1, d);
  return fromUtc(date);
}

function fromUtc(date: Date): IsoDate {
  const y = String(date.getUTCFullYear()).padStart(4, "0");
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function toUtc(iso: IsoDate): Date {
  const p = parseIsoDate(iso);
  if (!p) throw new RangeError(`Not a calendar day: ${iso}`);
  const date = new Date(0);
  date.setUTCFullYear(p.y, p.m - 1, p.d);
  return date;
}

export function addDays(iso: IsoDate, days: number): IsoDate {
  const date = toUtc(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return fromUtc(date);
}

/** Same day n months later; a day that month lacks becomes its last day (31 Jan + 1 month = 28 or 29 Feb). */
export function addMonths(iso: IsoDate, months: number): IsoDate {
  const p = parseIsoDate(iso);
  if (!p) throw new RangeError(`Not a calendar day: ${iso}`);
  const index = p.y * 12 + (p.m - 1) + months;
  const y = Math.floor(index / 12);
  const m = (index % 12 + 12) % 12 + 1;
  return toIsoDate(y, m, Math.min(p.d, daysInMonth(y, m)));
}

export function addYears(iso: IsoDate, years: number): IsoDate {
  return addMonths(iso, years * 12);
}

/** Day of the week, 0 = Sunday ... 6 = Saturday. */
export function weekday(iso: IsoDate): number {
  return toUtc(iso).getUTCDay();
}

export function startOfWeek(iso: IsoDate, weekStartsOn: WeekStart = 1): IsoDate {
  return addDays(iso, -((weekday(iso) - weekStartsOn + 7) % 7));
}

export function endOfWeek(iso: IsoDate, weekStartsOn: WeekStart = 1): IsoDate {
  return addDays(startOfWeek(iso, weekStartsOn), 6);
}

export function startOfMonth(iso: IsoDate): IsoDate {
  return `${iso.slice(0, 7)}-01`;
}

/** ISO strings of the same shape compare as text. */
export function compareIso(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isOutOfRange(iso: IsoDate, min?: string | null, max?: string | null): boolean {
  return (!!min && compareIso(iso, min) < 0) || (!!max && compareIso(iso, max) > 0);
}

export function clampIso(iso: IsoDate, min?: string | null, max?: string | null): IsoDate {
  if (min && compareIso(iso, min) < 0) return min;
  if (max && compareIso(iso, max) > 0) return max;
  return iso;
}

export type CalendarDay = { iso: IsoDate; day: number; inMonth: boolean };

/**
 * The month grid: always 6 weeks of 7 days (the panel never changes height between months), starting on
 * `weekStartsOn`. Days of the neighbouring months fill the first and last rows with inMonth = false.
 */
export function monthMatrix(year: number, month: number, weekStartsOn: WeekStart = 1): CalendarDay[][] {
  const first = toIsoDate(year, month, 1);
  let cursor = startOfWeek(first, weekStartsOn);
  const weeks: CalendarDay[][] = [];
  for (let w = 0; w < 6; w++) {
    const week: CalendarDay[] = [];
    for (let i = 0; i < 7; i++) {
      const p = parseIsoDate(cursor)!;
      week.push({ iso: cursor, day: p.d, inMonth: p.y === year && p.m === month });
      cursor = addDays(cursor, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

/** Today's day in a time zone (the browser's when none is given), as "YYYY-MM-DD". */
export function todayIso(timeZone?: string, now: Date = new Date()): IsoDate {
  // en-CA formats as YYYY-MM-DD; formatToParts keeps it independent of that detail.
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Weekday names in display order: `short` for the column heads ("lun.", "Mon"), `long` for screen readers. */
export function weekdayNames(locale: string, weekStartsOn: WeekStart = 1, style: "narrow" | "short" | "long" = "short"): string[] {
  const format = new Intl.DateTimeFormat(locale, { weekday: style, timeZone: "UTC" });
  // 4 Jan 2026 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => format.format(toUtc(toIsoDate(2026, 1, 4 + ((weekStartsOn + i) % 7)))));
}

/** "October 2026" / "octobre 2026". */
export function monthLabel(locale: string, year: number, month: number): string {
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(toUtc(toIsoDate(year, month, 1)));
}

/** A day for reading: "Wed 15 Oct 2026" style by default (the month in words, so 05/10 vs 10/05 is never ambiguous). */
export function formatIsoDate(iso: IsoDate, locale: string, options: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", year: "numeric" }): string {
  if (!isIsoDate(iso)) return "";
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(toUtc(iso));
}

/** The order of day, month and year in the locale's numeric dates: fr "dmy", en (US English) "mdy", "ymd" for others. */
export function numericDateOrder(locale: string): "dmy" | "mdy" | "ymd" {
  const parts = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }).formatToParts(toUtc("2026-10-15"));
  const order = parts
    .filter((p) => p.type === "day" || p.type === "month" || p.type === "year")
    .map((p) => p.type[0])
    .join("");
  return order === "mdy" || order === "ymd" ? order : "dmy";
}

/** The typed form of a day in the locale's order, digits only: "15/10/2026" (fr), "10/15/2026" (en). */
export function formatTypedDate(iso: IsoDate, locale: string): string {
  const p = parseIsoDate(iso);
  if (!p) return "";
  const dd = String(p.d).padStart(2, "0");
  const mm = String(p.m).padStart(2, "0");
  const yyyy = String(p.y).padStart(4, "0");
  const order = numericDateOrder(locale);
  return order === "mdy" ? `${mm}/${dd}/${yyyy}` : order === "ymd" ? `${yyyy}-${mm}-${dd}` : `${dd}/${mm}/${yyyy}`;
}

/**
 * A typed day back to "YYYY-MM-DD", or null when it is not a real day. Accepts the ISO form, and day, month and year
 * in the locale's order separated by / . - or spaces ("15/10/2026", "15.10.26", "15 10 2026"); a two-digit year
 * means 20xx. No guessing between orders: "05/10/2026" is 5 October in French and May 10 in US English.
 */
export function parseTypedDate(text: string, locale: string): IsoDate | null {
  const value = text.trim();
  if (!value) return null;
  if (ISO_DATE.test(value)) return isIsoDate(value) ? value : null;
  const pieces = value.split(/[\s./-]+/).filter(Boolean);
  if (pieces.length !== 3 || pieces.some((p) => !/^\d+$/.test(p))) return null;
  const order = numericDateOrder(locale);
  const [a, b, c] = pieces;
  const [d, m, y] = order === "mdy" ? [b, a, c] : order === "ymd" ? [c, b, a] : [a, b, c];
  if (d.length > 2 || m.length > 2 || (y.length !== 2 && y.length !== 4)) return null;
  const year = y.length === 2 ? 2000 + Number(y) : Number(y);
  const iso = `${String(year).padStart(4, "0")}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  return isIsoDate(iso) ? iso : null;
}

/** Where keyboard focus goes in the grid (WAI-ARIA date picker dialog keys), kept inside min and max. */
export function moveFocus(
  iso: IsoDate,
  key: string,
  { shiftKey = false, weekStartsOn = 1, min, max }: { shiftKey?: boolean; weekStartsOn?: WeekStart; min?: string | null; max?: string | null } = {},
): IsoDate | null {
  let next: IsoDate;
  switch (key) {
    case "ArrowLeft":
      next = addDays(iso, -1);
      break;
    case "ArrowRight":
      next = addDays(iso, 1);
      break;
    case "ArrowUp":
      next = addDays(iso, -7);
      break;
    case "ArrowDown":
      next = addDays(iso, 7);
      break;
    case "PageUp":
      next = shiftKey ? addYears(iso, -1) : addMonths(iso, -1);
      break;
    case "PageDown":
      next = shiftKey ? addYears(iso, 1) : addMonths(iso, 1);
      break;
    case "Home":
      next = startOfWeek(iso, weekStartsOn);
      break;
    case "End":
      next = endOfWeek(iso, weekStartsOn);
      break;
    default:
      return null;
  }
  return clampIso(next, min, max);
}

/** A range from two picks in any order: the earlier day is always `from`. */
export function orderRange(a: IsoDate, b: IsoDate): { from: IsoDate; to: IsoDate } {
  return compareIso(a, b) <= 0 ? { from: a, to: b } : { from: b, to: a };
}

export function isInRange(iso: IsoDate, from?: string | null, to?: string | null): boolean {
  return !!from && !!to && compareIso(iso, from) >= 0 && compareIso(iso, to) <= 0;
}

// "YYYY-MM-DDTHH:MM", the shape <input type="datetime-local"> gave.
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/;

export function splitDateTime(value: string | null | undefined): { date: IsoDate | ""; time: string } {
  const match = value ? DATE_TIME.exec(value) : null;
  if (!match || !isIsoDate(match[1]) || !isTime(match[2])) return { date: "", time: "" };
  return { date: match[1], time: match[2] };
}

export function joinDateTime(date: string, time: string): string {
  return date && time ? `${date}T${time}` : "";
}
