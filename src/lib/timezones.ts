import { COUNTRY_CALL_ZONE, DEFAULT_CALL_ZONE, SPAN_ZONES, ZONE_CHOICES } from "@/lib/zone-map.generated";

// A lead's local time and calling hours in the browser (Day 4 design 5.1). The same rules as the database
// (private.lead_call_zone, private.next_working_day; 4c's call_zone_open):
// - a picked zone wins; otherwise the country's zone; a country with several zones is a span key ("US"), in calling
//   hours only while both its eastern and western ends are; no country: Europe/Paris;
// - calling hours are Monday to Friday, 09:00 to 18:00 local; the lunch switch (off by default, Haider 11 Oct) skips
//   12:00 to 14:00 for European zones only (spans ignore it: their overlap is already short).
// Zone names come from Intl, so they need no translation.
export const CALL_WINDOW = { weekdays: [1, 2, 3, 4, 5], start: 9 * 60, end: 18 * 60, lunch: [12 * 60, 14 * 60] } as const;

/** The lead's calling zone key: an IANA zone or a span key. */
export function callZone(timezone: string | null | undefined, country: string | null | undefined): string {
  return timezone || (country ? COUNTRY_CALL_ZONE[country] : undefined) || DEFAULT_CALL_ZONE;
}

/** [eastern zone, western zone] for a span key, null for a plain zone. */
export function spanEnds(key: string): readonly [string, string] | null {
  return SPAN_ZONES[key] ?? null;
}

/** The zones a person may pick for a lead in this country (only countries with several zones), or null. */
export function zoneChoices(country: string | null | undefined): readonly string[] | null {
  return (country && ZONE_CHOICES[country]) || null;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(zone: string) {
  let f = partsFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    partsFormatters.set(zone, f);
  }
  return f;
}

const weekdays: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export type LocalParts = { year: number; month: number; day: number; weekday: number; minutes: number; date: string };

/** The wall-clock date and time at `at` in `zone`: ISO weekday (1 Monday … 7 Sunday), minutes since midnight. */
export function localParts(zone: string, at: Date): LocalParts {
  const map: Record<string, string> = {};
  for (const p of partsFormatter(zone).formatToParts(at)) map[p.type] = p.value;
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  return {
    year,
    month,
    day,
    weekday: weekdays[map.weekday] ?? 1,
    minutes: Number(map.hour) * 60 + Number(map.minute),
    date: `${map.year}-${map.month}-${map.day}`,
  };
}

/** The calendar date ("2026-10-12") at `at` in `zone`. */
export function localDate(zone: string, at: Date): string {
  return localParts(zone, at).date;
}

/** Offset of `zone` from UTC at `at`, in minutes (Paris in summer: 120). */
export function zoneOffset(zone: string, at: Date): number {
  const p = localParts(zone, at);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, Math.floor(p.minutes / 60), p.minutes % 60);
  return Math.round((asUtc - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
}

function wallClock(zone: string, at: number): number {
  const p = localParts(zone, new Date(at));
  return Date.UTC(p.year, p.month - 1, p.day, Math.floor(p.minutes / 60), p.minutes % 60);
}

/**
 * The instant when the wall clock in `zone` shows `date` at `time` ("09:00"), the way PostgreSQL reads
 * `(date + time) at time zone zone`: a time that happens twice (clocks going back) is read as standard time, and a time
 * that never happens (clocks going forward) is read with the standard offset too, so it lands an hour later.
 */
export function zonedInstant(date: string, time: string, zone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const offsets = [...new Set([zoneOffset(zone, new Date(wall - 86_400_000)), zoneOffset(zone, new Date(wall + 86_400_000))])];
  const matching = offsets.map((o) => wall - o * 60_000).filter((t) => wallClock(zone, t) === wall);
  if (matching.length === 1) return new Date(matching[0]);
  if (matching.length > 1) return new Date(Math.max(...matching));
  return new Date(wall - Math.min(...offsets) * 60_000);
}

/** Adds days to a calendar date ("2026-10-12" + 1 → "2026-10-13"). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** ISO weekday of a calendar date (1 Monday … 7 Sunday). */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
}

/** The zone used for a key's dates: a span's eastern end, else the key itself. */
export function primaryZone(key: string): string {
  return spanEnds(key)?.[0] ?? key;
}

/**
 * 09:00 local on the Nth weekday after `at` in the key's zone (a span uses its eastern end). The same rule as
 * private.next_working_day; tests/unit/next-working-day.spec.ts runs the SQL test's own cases.
 */
export function nextWorkingDay(at: Date, days: number, key: string): Date {
  if (!Number.isInteger(days) || days < 1 || days > 10) throw new RangeError("1 to 10 working days");
  const zone = primaryZone(key);
  let date = localDate(zone, at);
  for (let n = 0; n < days; ) {
    date = addDays(date, 1);
    if (weekdayOf(date) < 6) n += 1;
  }
  return zonedInstant(date, "09:00", zone);
}

/** The calendar date of the next working day on the lead's side (the default follow-up for Interested). */
export function nextWorkingDate(at: Date, key: string): string {
  return localDate(primaryZone(key), nextWorkingDay(at, 1, key));
}

function zoneOpen(zone: string, at: Date, skipLunch: boolean): boolean {
  const p = localParts(zone, at);
  if (!(CALL_WINDOW.weekdays as readonly number[]).includes(p.weekday)) return false;
  if (p.minutes < CALL_WINDOW.start || p.minutes >= CALL_WINDOW.end) return false;
  if (skipLunch && zone.startsWith("Europe/") && p.minutes >= CALL_WINDOW.lunch[0] && p.minutes < CALL_WINDOW.lunch[1]) {
    return false;
  }
  return true;
}

/** True during calling hours on the lead's side (a span: both ends at once). */
export function isOpen(key: string, at: Date, skipLunch = false): boolean {
  const ends = spanEnds(key);
  return ends ? zoneOpen(ends[0], at, false) && zoneOpen(ends[1], at, false) : zoneOpen(key, at, skipLunch);
}

/**
 * The next instant calling hours open (null when they are open now, or none within 8 days). Openings fall on a whole
 * hour of local time, which is a quarter hour in UTC for every zone, so a 15-minute walk finds them exactly.
 */
export function nextOpening(key: string, at: Date, skipLunch = false): Date | null {
  if (isOpen(key, at, skipLunch)) return null;
  const step = 15 * 60_000;
  const start = at.getTime();
  const end = start + 8 * 24 * 60 * 60_000;
  const zones = spanEnds(key) ?? [key];
  let t = Math.ceil(start / step) * step;
  // Closed stretches are skipped in one jump (to the zone's next midnight, 05:00, the opening hour or the end of lunch)
  // instead of 15 minutes at a time: the walk read the clock up to 768 times, about 30 ms at 4x CPU on a weekend.
  while (t <= end) {
    if (isOpen(key, new Date(t), skipLunch)) {
      // A jump can overshoot by a daylight-saving hour: step back while the quarter before is open too.
      while (t - step > start && isOpen(key, new Date(t - step), skipLunch)) t -= step;
      return new Date(t);
    }
    let skip = 0;
    for (const zone of zones) {
      const p = localParts(zone, new Date(t));
      const minutes =
        !(CALL_WINDOW.weekdays as readonly number[]).includes(p.weekday) || p.minutes >= CALL_WINDOW.end
          ? 1440 - p.minutes
          : p.minutes < 300
            ? 300 - p.minutes
            : p.minutes < CALL_WINDOW.start
              ? CALL_WINDOW.start - p.minutes
              : skipLunch && zones.length === 1 && zone.startsWith("Europe/") && p.minutes >= CALL_WINDOW.lunch[0] && p.minutes < CALL_WINDOW.lunch[1]
                ? CALL_WINDOW.lunch[1] - p.minutes
                : 0;
      skip = Math.max(skip, minutes);
    }
    t += Math.max(step, Math.floor((skip * 60_000) / step) * step);
  }
  return null;
}

/**
 * The zone this browser is in (null when unknown). Worked out once per page load: it is read on every render of the
 * timeline and the composer, and building an Intl.DateTimeFormat each time cost about 0.4 ms at 4x CPU.
 */
let zoneOnce: string | null | undefined;
export function browserZone(): string | null {
  if (zoneOnce !== undefined) return zoneOnce;
  try {
    zoneOnce = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    zoneOnce = null;
  }
  return zoneOnce;
}

/** The zone's own name in this language ("heure : Royaume-Uni", "Pacific Time"), or the IANA id when Intl has none. */
export function zoneName(zone: string, locale: string, style: "long" | "longGeneric" | "shortOffset" = "longGeneric"): string {
  try {
    return (
      new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: style })
        .formatToParts(new Date())
        .find((p) => p.type === "timeZoneName")?.value ?? zone.replace(/_/g, " ")
    );
  } catch {
    return zone.replace(/_/g, " ");
  }
}

/** The city part of an IANA zone ("America/Los_Angeles" → "Los Angeles"): a short label for zone pickers. */
export function zoneCity(zone: string): string {
  return (zone.split("/").pop() ?? zone).replace(/_/g, " ");
}
