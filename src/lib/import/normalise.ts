// Cleans every row with one set of rules (design 3.5) and produces the stage payload: a rejected row carries only its
// row number and problem codes, a staged row carries the canonical values. Pure and synchronous.
import { countryCodes } from "../countries";
import type { ColumnMapping, FieldTarget } from "./headers";
import type { ParsedRecord } from "./parse";
import {
  BAD_FIELD_POLICY,
  DEFAULT_STATUS,
  DEFAULT_TIME_ZONE,
  FIELD_PROBLEM_FIX,
  FIX_CODES,
  ImportFileError,
  ImportRulesError,
  LIMITS,
  MIN_ACTIVITY_LOCAL,
  PROBLEM_CODES,
  ROW_PROBLEMS,
  type BadFieldPolicy,
  type FieldProblem,
  type FixCode,
  type LeadStatus,
  type ProblemCode,
} from "./rules";
import { EMAIL_PATTERN, PHONE_PATTERN, isLocalDateTime, type RejectedRow, type StagedRow } from "./schema";
import { cleanCell, cleanText, codePointLength, stripFormulaGuard } from "./text";
import {
  countryKey,
  createOwnerMatcher,
  matchCountry,
  ownerKey,
  statusKey,
  suggestStatus,
  type DateOrder,
  type TeamMemberLite,
} from "./values";

export type FieldResult<P extends ProblemCode> = { value: string | null; problem: P | null };

const ok = <P extends ProblemCode>(value: string | null): FieldResult<P> => ({ value, problem: null });
const bad = <P extends ProblemCode>(problem: P): FieldResult<P> => ({ value: null, problem });

// ---------- Name, email, phone, city ----------

export function normaliseName(raw: string | null | undefined): FieldResult<"name_missing" | "name_too_long"> {
  const s = cleanCell(raw);
  if (!s) return { value: "", problem: "name_missing" };
  if (codePointLength(s) > LIMITS.maxNameChars) return { value: s, problem: "name_too_long" };
  return ok(s);
}

export function normaliseEmail(raw: string | null | undefined): FieldResult<"email_invalid"> {
  let s = cleanCell(raw);
  if (!s) return ok(null);
  if (/^mailto:/i.test(s)) s = s.replace(/^mailto:\s*/i, "").split("?")[0].trim();
  s = s.toLowerCase();
  // More than one address in a cell, or anything that is not one plain address, is refused.
  if (!s || /[,;]/.test(s) || !EMAIL_PATTERN.test(s) || codePointLength(s) > LIMITS.maxEmailChars) {
    return bad("email_invalid");
  }
  return ok(s);
}

const UNICODE_DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;
// 3.36E+11 or 6,12345678E+8: Excel turned the number into scientific notation and lost digits.
const SCIENTIFIC = /^[+-]?\d+(?:[.,]\d+)?e[+-]?\d+$/i;

export function normalisePhone(
  raw: string | null | undefined,
): FieldResult<"phone_invalid" | "phone_mangled" | "phone_too_long"> {
  const s = cleanCell(raw)
    .replace(UNICODE_DASHES, "-")
    .replace(/^tel:\s*/i, "")
    .trim();
  if (!s) return ok(null);
  if (SCIENTIFIC.test(s)) return bad("phone_mangled");
  const digits = s.replace(/[^0-9]/g, "").length;
  if (!PHONE_PATTERN.test(s) || digits < LIMITS.minPhoneDigits) return bad("phone_invalid");
  if (codePointLength(s) > LIMITS.maxPhoneChars) return bad("phone_too_long");
  return ok(s);
}

export function normaliseCity(raw: string | null | undefined): FieldResult<"city_too_long"> {
  const s = cleanCell(raw);
  if (!s) return ok(null);
  if (codePointLength(s) > LIMITS.maxCityChars) return bad("city_too_long");
  return ok(s);
}

// ---------- Dates ----------

const formatters = new Map<string, Intl.DateTimeFormat>();

function localFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.length > 64) return false;
  try {
    localFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The time zones the browser knows (for the source time zone picker); Europe/Paris when the list is unavailable. */
export function supportedTimeZones(): string[] {
  try {
    const zones = Intl.supportedValuesOf("timeZone");
    return zones.length ? zones : [DEFAULT_TIME_ZONE];
  } catch {
    return [DEFAULT_TIME_ZONE];
  }
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** Wall-clock time of an instant in a time zone, as "YYYY-MM-DDTHH:MM:SS". */
export function toLocalDateTime(instantMs: number, timeZone: string): string {
  const parts = localFormatter(timeZone).formatToParts(new Date(instantMs));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year").padStart(4, "0")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}`;
}

function local(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): string {
  return `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}`;
}

function utcMs(y: number, mo: number, d: number, h: number, mi: number, s: number): number {
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d); // setUTCFullYear keeps years below 100 as written (Date.UTC would add 1900)
  date.setUTCHours(h, mi, s, 0);
  return date.getTime();
}

// YYYY-MM-DD (or YYYY/MM/DD) with an optional [ T]HH:mm[:ss[.fff]] and an optional Z or ±hh[:mm] after a time.
const ISO_DATE =
  /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d{1,9})?)? ?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;
// D/M/YYYY, D.M.YYYY or D-M-YYYY (or 2-digit years) in the chosen order, optional HH:mm[:ss], AM/PM only in MDY.
const NUMERIC_DATE =
  /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4}|\d{2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?: ?([AP])\.?M\.?)?)?$/i;
// Excel serial day numbers (days since 1899-12-30, fraction = time of day).
const SERIAL_DATE = /^(\d{5})(?:[.,](\d{1,15}))?$/;
const SERIAL_EPOCH_MS = Date.UTC(1899, 11, 30);

export type DateContext = { order: DateOrder; timeZone: string; nowLocal: string };

type Parts = [y: number, mo: number, d: number, h: number, mi: number, s: number];

function readDate(s: string, order: DateOrder, timeZone: string): Parts | "invalid" | "too_old" {
  let m = ISO_DATE.exec(s);
  if (m) {
    const parts: Parts = [+m[1], +m[3], +m[4], +(m[5] ?? 0), +(m[6] ?? 0), +(m[7] ?? 0)];
    if (!isLocalDateTime(local(...parts))) return "invalid";
    const offset = m[8];
    if (!offset) return parts;
    if (parts[0] < 1989) return "too_old";
    let offsetMinutes = 0;
    if (offset.toUpperCase() !== "Z") {
      const sign = offset[0] === "-" ? -1 : 1;
      const digits = offset.slice(1).replace(":", "");
      const oh = Number(digits.slice(0, 2));
      const om = Number(digits.slice(2) || 0);
      if (oh > 14 || om > 59) return "invalid";
      offsetMinutes = sign * (oh * 60 + om);
    }
    const instant = utcMs(...parts) - offsetMinutes * 60_000;
    const converted = toLocalDateTime(instant, timeZone);
    const c = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(converted);
    return c ? (c.slice(1).map(Number) as Parts) : "invalid";
  }
  m = NUMERIC_DATE.exec(s);
  if (m) {
    const first = +m[1];
    const second = +m[3];
    const year = m[4].length === 2 ? 2000 + +m[4] : +m[4];
    const [day, month] = order === "dmy" ? [first, second] : [second, first];
    let hour = +(m[5] ?? 0);
    const meridiem = m[8]?.toUpperCase();
    if (meridiem) {
      if (order !== "mdy" || hour < 1 || hour > 12) return "invalid";
      hour = (hour % 12) + (meridiem === "P" ? 12 : 0);
    }
    const parts: Parts = [year, month, day, hour, +(m[6] ?? 0), +(m[7] ?? 0)];
    return isLocalDateTime(local(...parts)) ? parts : "invalid";
  }
  m = SERIAL_DATE.exec(s);
  if (m) {
    const days = +m[1];
    if (days < 20_000 || days > 80_000) return "invalid";
    const fraction = m[2] ? Number(`0.${m[2]}`) : 0;
    const d = new Date(SERIAL_EPOCH_MS + days * 86_400_000 + Math.round(fraction * 86_400) * 1000);
    return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()];
  }
  return "invalid";
}

/**
 * Last activity in the source time zone as "YYYY-MM-DDTHH:MM:SS". A date without a time is 00:00 local; a time with
 * an offset is converted into the source time zone. A spring-gap time (02:30 on the DST night) is kept as written:
 * SQL's AT TIME ZONE moves it forward.
 */
export function normaliseDate(
  raw: string | null | undefined,
  ctx: DateContext,
): FieldResult<"date_invalid" | "date_future" | "date_too_old"> {
  const s = cleanCell(raw);
  if (!s) return ok(null);
  const parts = readDate(s, ctx.order, ctx.timeZone);
  if (parts === "invalid") return bad("date_invalid");
  if (parts === "too_old") return bad("date_too_old");
  const value = local(...parts);
  if (!isLocalDateTime(value)) return bad("date_invalid");
  if (value < MIN_ACTIVITY_LOCAL) return bad("date_too_old");
  if (value > ctx.nowLocal) return bad("date_future");
  return ok(value);
}

// ---------- Rows ----------

export type NormaliseOptions = {
  /** Target per column (headers.ts); its length is the number of header columns. */
  mapping: ColumnMapping;
  team: readonly TeamMemberLite[];
  dateOrder: DateOrder;
  /** IANA time zone the sheet's dates are written in (default profile zone, Europe/Paris). */
  timeZone: string;
  /** Explicit status choices by statusKey(); they win over suggestions. */
  statusChoices?: ReadonlyMap<string, LeadStatus>;
  /** Status for a blank cell (Cold unless changed). */
  defaultStatus?: LeadStatus;
  /** Explicit owner choices by ownerKey(): a user id, or null for Unassigned. */
  ownerChoices?: ReadonlyMap<string, string | null>;
  /** Explicit country choices by countryKey(): an ISO code, or null for "Leave blank". */
  countryChoices?: ReadonlyMap<string, string | null>;
  badFieldPolicy?: BadFieldPolicy;
  now?: Date;
};

/** Canonical values for the screen (kept in memory only; a rejected row never sends them). */
export type DisplayValues = {
  name: string;
  owner_id: string | null;
  lead_status: LeadStatus | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  country: string | null;
  last_activity: string | null;
};

export type NormalisedRecord =
  | { row_no: number; rejected: true; payload: RejectedRow; problems: ProblemCode[]; fixes: []; display: DisplayValues }
  | { row_no: number; rejected: false; payload: StagedRow; problems: []; fixes: FixCode[]; display: DisplayValues };

const ROW_PROBLEM_SET: ReadonlySet<ProblemCode> = new Set(ROW_PROBLEMS);
const COUNTRY_SET: ReadonlySet<string> = new Set(countryCodes);

/** Builds the per-row function once (indexes, owner matcher, current local time) for a whole file. */
export function createNormaliser(options: NormaliseOptions): (record: ParsedRecord) => NormalisedRecord {
  const { mapping, timeZone, dateOrder } = options;
  if (!mapping.includes("name")) throw new ImportRulesError("name_unmapped");
  if (!isValidTimeZone(timeZone)) throw new ImportRulesError("bad_time_zone");
  const policy = options.badFieldPolicy ?? BAD_FIELD_POLICY;
  const defaultStatus = options.defaultStatus ?? DEFAULT_STATUS;
  const matchOwnerId = createOwnerMatcher(options.team);
  const ctx: DateContext = {
    order: dateOrder,
    timeZone,
    nowLocal: toLocalDateTime((options.now ?? new Date()).getTime(), timeZone),
  };
  const column = (field: FieldTarget) => mapping.indexOf(field);
  const cols = {
    name: column("name"),
    owner: column("owner"),
    phone: column("phone"),
    email: column("email"),
    status: column("status"),
    last_activity: column("last_activity"),
    city: column("city"),
    country: column("country"),
  };
  const importedColumns = mapping.flatMap((target, i) => (target === "ignore" ? [] : [i]));
  const headerCount = mapping.length;

  // Owner, status and country cells repeat a lot: each distinct spelling is resolved once.
  const resolveOwner = memo((raw): { id: string | null } | null => {
    const key = ownerKey(raw);
    if (!key) return null;
    return { id: options.ownerChoices?.has(key) ? (options.ownerChoices.get(key) ?? null) : matchOwnerId(raw) };
  });
  const resolveStatus = memo((raw): LeadStatus => {
    const key = statusKey(raw);
    if (!key) return defaultStatus;
    const chosen = options.statusChoices?.get(key) ?? suggestStatus(raw);
    if (!chosen) throw new ImportRulesError("status_unmapped");
    return chosen;
  });
  const resolveCountry = memo((raw): { code: string | null } | null => {
    const key = countryKey(raw);
    if (!key) return null;
    const picked = options.countryChoices?.has(key) ? (options.countryChoices.get(key) ?? null) : matchCountry(raw);
    return { code: picked && COUNTRY_SET.has(picked) ? picked : null };
  });

  return (record) => {
    const cells = record.cells;
    const cell = (i: number) => (i >= 0 ? (cells[i] ?? "") : "");
    const problems = new Set<ProblemCode>();
    const fixes = new Set<FixCode>();

    // Row problems: they always reject the row.
    for (let i = headerCount; i < cells.length; i++) {
      if (cleanText(cells[i]) !== "") {
        problems.add("columns_extra");
        break;
      }
    }
    for (const i of importedColumns) {
      // Measured without the problems file's formula guard, so a fixed file re-imports with the same result.
      const raw = stripFormulaGuard(cells[i] ?? "");
      if (raw.length > LIMITS.maxCellChars && codePointLength(raw) > LIMITS.maxCellChars) problems.add("cell_too_long");
    }
    const name = normaliseName(cell(cols.name));
    if (name.problem) problems.add(name.problem);

    // Fields that a bad value can leave empty.
    const email = normaliseEmail(cell(cols.email));
    const phone = normalisePhone(cell(cols.phone));
    const lastActivity = normaliseDate(cell(cols.last_activity), ctx);
    const city = normaliseCity(cell(cols.city));
    const fieldProblems = [email.problem, phone.problem, lastActivity.problem, city.problem].filter(
      (p): p is FieldProblem => p !== null,
    );

    // Values decided on the mapping screen.
    const owner = resolveOwner(cell(cols.owner));
    const ownerId = owner?.id ?? null;
    if (owner && !owner.id) fixes.add("owner_unassigned");
    const leadStatus = resolveStatus(cell(cols.status));
    const countryChoice = resolveCountry(cell(cols.country));
    const country = countryChoice?.code ?? null;
    if (countryChoice && !countryChoice.code) fixes.add("country_dropped");

    const display: DisplayValues = {
      name: name.value ?? "",
      owner_id: ownerId,
      lead_status: leadStatus,
      phone: phone.value,
      email: email.value,
      city: city.value,
      country,
      last_activity: lastActivity.value,
    };

    const hasRowProblem = [...problems].some((p) => ROW_PROBLEM_SET.has(p));
    if (hasRowProblem || (policy === "reject_row" && fieldProblems.length > 0)) {
      for (const p of fieldProblems) problems.add(p);
      const sorted = PROBLEM_CODES.filter((p) => problems.has(p));
      return {
        row_no: record.row_no,
        rejected: true,
        payload: { row_no: record.row_no, problems: sorted },
        problems: sorted,
        fixes: [],
        display,
      };
    }
    for (const p of fieldProblems) fixes.add(FIELD_PROBLEM_FIX[p]);
    const sortedFixes = FIX_CODES.filter((f) => fixes.has(f));
    return {
      row_no: record.row_no,
      rejected: false,
      payload: {
        row_no: record.row_no,
        name: name.value ?? "",
        owner_id: ownerId,
        lead_status: leadStatus,
        phone: phone.value,
        email: email.value,
        city: city.value,
        country,
        last_activity: lastActivity.value,
        fixes: sortedFixes,
      },
      problems: [],
      fixes: sortedFixes,
      display,
    };
  };
}

function memo<T>(fn: (raw: string) => T): (raw: string) => T {
  const cache = new Map<string, T>();
  return (raw) => {
    if (cache.has(raw)) return cache.get(raw) as T;
    const value = fn(raw);
    cache.set(raw, value);
    return value;
  };
}

export function normaliseRecords(records: readonly ParsedRecord[], options: NormaliseOptions): NormalisedRecord[] {
  const normalise = createNormaliser(options);
  return records.map(normalise);
}

export type SliceOptions = {
  /** Rows per slice (default 1,000: well under 50 ms on a laptop). */
  sliceSize?: number;
  /** Runs `resume` when the main thread is free again (default setTimeout 0). */
  schedule?: (resume: () => void) => void;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
};

/** normaliseRecords in slices that yield to the main thread, for the browser (30k rows stay responsive). */
export async function normaliseInSlices(
  records: readonly ParsedRecord[],
  options: NormaliseOptions,
  slices: SliceOptions = {},
): Promise<NormalisedRecord[]> {
  const normalise = createNormaliser(options);
  const size = Math.max(1, slices.sliceSize ?? 1000);
  const schedule = slices.schedule ?? ((resume: () => void) => void setTimeout(resume, 0));
  const out: NormalisedRecord[] = [];
  for (let start = 0; start < records.length; start += size) {
    if (slices.signal?.aborted) throw new ImportFileError("aborted");
    const end = Math.min(records.length, start + size);
    for (let i = start; i < end; i++) out.push(normalise(records[i]));
    slices.onProgress?.(end, records.length);
    if (end < records.length) await new Promise<void>((resolve) => schedule(resolve));
  }
  return out;
}

export type Tally = {
  staged: number;
  rejected: number;
  withFixes: number;
  problems: Map<ProblemCode, number>;
  fixes: Map<FixCode, number>;
};

/** Counts for the live preview ("Ready to check: 29,410 · Need fixing: 590"). */
export function tally(rows: readonly NormalisedRecord[]): Tally {
  const t: Tally = { staged: 0, rejected: 0, withFixes: 0, problems: new Map(), fixes: new Map() };
  for (const row of rows) {
    if (row.rejected) t.rejected++;
    else t.staged++;
    if (row.fixes.length) t.withFixes++;
    for (const p of row.problems) t.problems.set(p, (t.problems.get(p) ?? 0) + 1);
    for (const f of row.fixes) t.fixes.set(f, (t.fixes.get(f) ?? 0) + 1);
  }
  return t;
}
