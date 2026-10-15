// Pure time rules behind the app's own time picker (no native time input, Haider 15 Oct 2026). A time is always
// "HH:MM" on a 24-hour clock, the shape <input type="time"> gave; only what the person reads follows the locale.

export type HourCycle = "h12" | "h23";

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isTime(value: string | null | undefined): boolean {
  return !!value && HH_MM.test(value);
}

export function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

export function fromMinutes(minutes: number): string {
  const total = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** Every step through the day, "00:00" to "23:45" for 15 minutes, kept inside min and max when given. */
export function timeList(step = 15, min?: string | null, max?: string | null): string[] {
  const size = Math.max(1, Math.min(720, Math.floor(step)));
  const from = isTime(min) ? toMinutes(min!) : 0;
  const to = isTime(max) ? toMinutes(max!) : 1439;
  const list: string[] = [];
  for (let m = 0; m < 1440; m += size) if (m >= from && m <= to) list.push(fromMinutes(m));
  return list;
}

/** The locale's own clock: "h12" for US English, "h23" for French. */
export function localeHourCycle(locale: string): HourCycle {
  const cycle = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hourCycle;
  return cycle === "h11" || cycle === "h12" ? "h12" : "h23";
}

/** A time for reading: "09:15" on a 24-hour clock, "9:15 AM" on a 12-hour one. */
export function formatTime(time: string, locale: string, hourCycle: HourCycle = localeHourCycle(locale)): string {
  if (!isTime(time)) return "";
  if (hourCycle === "h23") return time;
  const [h, m] = time.split(":").map(Number);
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", hourCycle: "h12", timeZone: "UTC" }).format(
    new Date(Date.UTC(2026, 0, 1, h, m)),
  );
}

/**
 * Typed text back to "HH:MM", or null. Accepts "9", "915", "0915", "9:15", "9.15", "9h15", "9 h 15" (French),
 * "21:15", and a 12-hour time with am/pm in any case or spacing ("9:15pm", "9 PM", "12 am" = 00:00).
 */
export function parseTypedTime(text: string): string | null {
  const value = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!value) return null;
  const match = /^(\d{1,2})(?:\s?[:.h]\s?(\d{2})?|(\d{2}))?\s?(a\.?m\.?|p\.?m\.?|a|p)?$/.exec(value);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2] ?? match[3] ?? "0");
  const meridiem = match[4]?.[0];
  if (minutes > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (meridiem === "p" ? 12 : 0);
  } else if (hours > 23) return null;
  return fromMinutes(hours * 60 + minutes);
}

/** The list entry to highlight for a value: itself, else the nearest one after it (wrapping to the start). */
export function nearestTimeIndex(list: string[], value: string | null | undefined): number {
  if (!list.length) return -1;
  if (!isTime(value)) return 0;
  const target = toMinutes(value!);
  const index = list.findIndex((t) => toMinutes(t) >= target);
  return index === -1 ? 0 : index;
}

export function isTimeOutOfRange(time: string, min?: string | null, max?: string | null): boolean {
  if (!isTime(time)) return false;
  const m = toMinutes(time);
  return (isTime(min) && m < toMinutes(min!)) || (isTime(max) && m > toMinutes(max!));
}
