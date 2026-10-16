import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// No migration may depend on the session's time zone for a date or a time of day (Day 7 follow-up). The app's day is
// the Paris day, written out as `(now() at time zone 'Europe/Paris')::date`; a bare current_date or now()::date is the
// day in whatever zone the connection happens to run (UTC on Supabase, Europe/Paris in the DB tests since PGTZ was set
// there), so the same SQL answers differently by connection. The DB tests once broke on exactly that (docs/log.md,
// 2026-10-15: current_date + 91 was the UTC day between 22:00 and 24:00 UTC).
//
// What counts, outside comments and string literals:
//   - current_date, current_time, localtime, localtimestamp (always the session's zone);
//   - an instant (now(), current_timestamp, transaction_/statement_/clock_timestamp(), or a column or variable named
//     *_at, which in this schema is always a timestamptz) turned into a date or a time of day in the session's zone:
//     cast to date, time, timetz or timestamp (without time zone), or passed to to_char(), date(), extract() or
//     date_part() for any field but epoch. Each instant must go through `at time zone '<zone>'` first;
//   - date_trunc() with two arguments at hour or coarser, unless its argument is already a timestamp without time zone
//     (`... at time zone ...` or `...::timestamp`). The three-argument form names its zone and is fine.
// A cast to text is not flagged: the text carries the offset, so the instant survives.
//
// Already-applied migrations are never edited (a changed applied file would not re-run and would drift from the
// databases that ran it), so the findings in them are listed below with the reason each one is acceptable. A new
// migration that needs one of these patterns should use the explicit-zone form instead of growing this list.
const dir = join(__dirname, "../../supabase/migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

type Hit = { line: number; expr: string };

// Comments become spaces (newlines kept, so line numbers hold); string literals stay, but their spans are returned so
// a hit inside one ('... current_date ...' in a message) is ignored. Dollar-quoted bodies are code and stay as they are.
function scrub(sql: string): { code: string; strings: Array<[number, number]> } {
  let out = "";
  const strings: Array<[number, number]> = [];
  let i = 0;
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  while (i < sql.length) {
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      out += blank(sql.slice(i, stop));
      i = stop;
    } else if (sql.startsWith("/*", i)) {
      let depth = 0;
      let j = i;
      while (j < sql.length) {
        if (sql.startsWith("/*", j)) {
          depth += 1;
          j += 2;
        } else if (sql.startsWith("*/", j)) {
          depth -= 1;
          j += 2;
          if (depth === 0) break;
        } else j += 1;
      }
      out += blank(sql.slice(i, j));
      i = j;
    } else if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j += 1;
      }
      strings.push([i, j]);
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else {
      out += sql[i];
      i += 1;
    }
  }
  return { code: out, strings };
}

const INSTANT =
  /(?:\bnow\s*\(\s*\)|\bcurrent_timestamp\b(?:\s*\(\s*\d+\s*\))?|\b(?:transaction|statement|clock)_timestamp\s*\(\s*\)|\b(?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*_at\b)/gi;

// True when some instant in the expression is used without `at time zone` straight after it.
function hasLocalInstant(expr: string): boolean {
  for (const m of expr.matchAll(INSTANT)) {
    const rest = expr.slice((m.index ?? 0) + m[0].length);
    if (!/^\s*at\s+time\s+zone\b/i.test(rest)) return true;
  }
  return false;
}

// Index of the parenthesis that closes the one at `open`.
function closing(code: string, open: number): number {
  let depth = 0;
  for (let j = open; j < code.length; j++) {
    if (code[j] === "(") depth += 1;
    else if (code[j] === ")" && --depth === 0) return j;
  }
  return code.length - 1;
}

// Splits "a, f(b, c), d" at its top-level commas.
function args(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let j = 0; j < inner.length; j++) {
    if (inner[j] === "(") depth += 1;
    else if (inner[j] === ")") depth -= 1;
    else if (inner[j] === "," && depth === 0) {
      parts.push(inner.slice(start, j));
      start = j + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts.map((p) => p.trim());
}

// Where the operand of a `::type` cast starts: a parenthesised group (with the function name before it, if any) or a word.
function operandBefore(code: string, at: number): number {
  let j = at - 1;
  while (j >= 0 && /\s/.test(code[j])) j -= 1;
  let start: number;
  if (code[j] === ")") {
    let depth = 0;
    let k = j;
    for (; k >= 0; k--) {
      if (code[k] === ")") depth += 1;
      else if (code[k] === "(" && --depth === 0) break;
    }
    start = k;
    while (start > 0 && /[a-z0-9_.]/i.test(code[start - 1])) start -= 1;
  } else {
    start = j;
    while (start > 0 && /[a-z0-9_.]/i.test(code[start - 1])) start -= 1;
  }
  return Math.max(start, 0);
}

const LOCAL_TYPE = /^(?:date|timetz|time(?:\s+with(?:out)?\s+time\s+zone)?|timestamp(?!\s+with\s+time\s+zone)(?:\s+without\s+time\s+zone)?)\b/i;
const COARSE = new Set(["hour", "day", "week", "month", "quarter", "year", "decade", "century", "millennium"]);
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

function findLocalDates(sql: string): Hit[] {
  const { code, strings } = scrub(sql);
  const inString = (at: number) => strings.some(([a, b]) => at >= a && at <= b);
  const lineOf = (at: number) => code.slice(0, at).split("\n").length;
  const hits: Array<Hit & { at: number }> = [];
  const add = (at: number, expr: string) => {
    if (!inString(at)) hits.push({ at, line: lineOf(at), expr: norm(expr) });
  };

  for (const m of code.matchAll(/\b(?:current_date|current_time|localtime|localtimestamp)\b/gi)) add(m.index, m[0]);

  for (const m of code.matchAll(/::\s*/g)) {
    const typeAt = m.index + m[0].length;
    if (!LOCAL_TYPE.test(code.slice(typeAt))) continue;
    const start = operandBefore(code, m.index);
    const type = code.slice(typeAt).match(LOCAL_TYPE)![0];
    if (hasLocalInstant(code.slice(start, m.index))) add(start, code.slice(start, typeAt + type.length));
  }

  for (const m of code.matchAll(/\b(cast|to_char|date|date_part|extract|date_trunc)\s*\(/gi)) {
    const open = m.index + m[0].length - 1;
    const close = closing(code, open);
    const inner = code.slice(open + 1, close);
    const whole = code.slice(m.index, close + 1);
    const fn = m[1].toLowerCase();
    if (fn === "cast") {
      const as = inner.match(/^([\s\S]*)\s+as\s+([\s\S]+)$/i);
      if (as && LOCAL_TYPE.test(as[2].trim()) && hasLocalInstant(as[1])) add(m.index, whole);
    } else if (fn === "to_char" || fn === "date") {
      if (hasLocalInstant(args(inner)[0] ?? "")) add(m.index, whole);
    } else if (fn === "extract") {
      const ex = inner.match(/^\s*([a-z_]+)\s+from\s+([\s\S]+)$/i);
      if (ex && ex[1].toLowerCase() !== "epoch" && hasLocalInstant(ex[2])) add(m.index, whole);
    } else if (fn === "date_part") {
      const [field = "", expr = ""] = args(inner);
      if (field.replace(/'/g, "").toLowerCase() !== "epoch" && hasLocalInstant(expr)) add(m.index, whole);
    } else {
      const parts = args(inner);
      const unit = (parts[0] ?? "").replace(/'/g, "").toLowerCase();
      const arg = parts[1] ?? "";
      const naive = /\bat\s+time\s+zone\b/i.test(arg) || /::\s*timestamp(?:\s+without\s+time\s+zone)?\s*$/i.test(arg);
      if (parts.length === 2 && COARSE.has(unit) && !naive) add(m.index, whole);
    }
  }

  return hits.sort((a, b) => a.at - b.at).map(({ line, expr }) => ({ line, expr }));
}

// Reviewed findings in migrations that are already applied (see the header). Each entry is file, line and the
// expression as the check prints it (whitespace collapsed).
const BOUNDS =
  "A sanity bound years wide (it only refuses absurd dates); in another session zone the bound moves by at most one " +
  "day at its far edge, which changes nothing a person can do. Applied migration: not edited.";
const ALLOWED: Array<{ file: string; line: number; expr: string; reason: string }> = [
  // A task's due date within five years, in private.task_guard (written in 20261011, redefined on Day 5 and Day 6).
  ...(
    [
      ["20261011120000_activity_hardening.sql", 333],
      ["20261015090000_deals_pipeline.sql", 227],
      ["20261019090000_sales_requests.sql", 792],
    ] as const
  ).flatMap(([file, line]) => [
    { file, line, expr: "(now() - interval '5 years')::date", reason: BOUNDS },
    { file, line, expr: "(now() + interval '5 years')::date", reason: BOUNDS },
  ]),
  // A deal's expected close date between a year ago and three years ahead.
  ...[377, 571, 1049, 1361].flatMap((line) => [
    { file: "20261015090000_deals_pipeline.sql", line, expr: "(now() - interval '1 year')::date", reason: BOUNDS },
    { file: "20261015090000_deals_pipeline.sql", line, expr: "(now() + interval '3 years')::date", reason: BOUNDS },
  ]),
  {
    file: "20261020090000_client_share.sql",
    line: 614,
    expr: "date_trunc('week', p.transit_eta)",
    reason:
      "transit_eta is a date: the implicit cast to timestamptz is midnight in the session zone and the ::date after " +
      "it reads the same zone back, so the Monday is the same in every zone. Applied migration: not edited.",
  },
  {
    file: "20261020090000_client_share.sql",
    line: 635,
    expr: "date_trunc('hour', now())",
    reason:
      "Rate-limit bucket key. Only a zone with a half-hour offset would move the hour edge, and the bucket is only " +
      "compared with buckets made the same way. Applied migration: not edited.",
  },
  {
    file: "20261020090000_client_share.sql",
    line: 636,
    expr: "date_trunc('day', now())",
    reason:
      "Rate-limit bucket key: the daily share caps restart at midnight in the session zone (UTC on Supabase, so " +
      "01:00 or 02:00 in Paris). Harmless as long as the zone does not change between calls; a fix migration that " +
      "redefines private.share_take with date_trunc('day', now(), 'Europe/Paris') is noted in docs/log.md. Applied " +
      "migration: not edited.",
  },
];

test("there are migrations to check", () => {
  expect(files.length).toBeGreaterThan(10);
  expect(files).toContain("20261015090000_deals_pipeline.sql");
});

for (const file of files) {
  test(`${file}: no date or time of day taken in the session's time zone`, () => {
    const found = findLocalDates(readFileSync(join(dir, file), "utf8"));
    const unexplained = found.filter(
      (h) => !ALLOWED.some((a) => a.file === file && a.line === h.line && a.expr === h.expr),
    );
    expect(
      unexplained.map((h) => `${file}:${h.line}  ${h.expr}`),
      "use `(now() at time zone 'Europe/Paris')::date` (or the zone in hand), never the session's zone",
    ).toEqual([]);
  });
}

test("every allowlisted finding is still there, with a reason", () => {
  for (const a of ALLOWED) {
    expect(files, `${a.file} exists`).toContain(a.file);
    expect(a.reason.length, `${a.file}:${a.line} has a reason`).toBeGreaterThan(40);
    const found = findLocalDates(readFileSync(join(dir, a.file), "utf8"));
    expect(found, `${a.file}:${a.line} ${a.expr} is still found`).toContainEqual({ line: a.line, expr: a.expr });
  }
});

test("the check itself: session-zone forms are caught", () => {
  const caught = (sql: string) => findLocalDates(sql).map((h) => h.expr);
  expect(caught("select current_date + 91")).toEqual(["current_date"]);
  expect(caught("select CURRENT_DATE, current_time, localtime, localtimestamp")).toEqual([
    "CURRENT_DATE",
    "current_time",
    "localtime",
    "localtimestamp",
  ]);
  expect(caught("v := now()::date;")).toEqual(["now()::date"]);
  expect(caught("v := now() :: DATE;")).toEqual(["now() :: DATE"]);
  expect(caught("v := current_timestamp::date;")).toEqual(["current_timestamp::date"]);
  expect(caught("v := now()::timestamp;")).toEqual(["now()::timestamp"]);
  expect(caught("v := now()::time;")).toEqual(["now()::time"]);
  expect(caught("v := now()::timestamp without time zone;")).toEqual(["now()::timestamp without time zone"]);
  expect(caught("v := clock_timestamp()::date;")).toEqual(["clock_timestamp()::date"]);
  expect(caught("v := (now() - interval '1 day')::date;")).toEqual(["(now() - interval '1 day')::date"]);
  expect(caught("where t.created_at::date = d")).toEqual(["t.created_at::date"]);
  expect(caught("select cast(now() as date)")).toEqual(["cast(now() as date)"]);
  expect(caught("select date(now())")).toEqual(["date(now())"]);
  expect(caught("select to_char(now(), 'YYYY-MM-DD')")).toEqual(["to_char(now(), 'YYYY-MM-DD')"]);
  expect(caught("select extract(hour from now())")).toEqual(["extract(hour from now())"]);
  expect(caught("select date_part('dow', c.created_at)")).toEqual(["date_part('dow', c.created_at)"]);
  expect(caught("select date_trunc('day', now())")).toEqual(["date_trunc('day', now())"]);
  expect(caught("select date_trunc('month', d.closed_at)")).toEqual(["date_trunc('month', d.closed_at)"]);
  // Inside a function body, which is code.
  expect(caught("create function f() returns date language sql as $$ select current_date $$;")).toEqual([
    "current_date",
  ]);
});

test("the check itself: explicit-zone forms, comments and strings pass", () => {
  const caught = (sql: string) => findLocalDates(sql).map((h) => h.expr);
  expect(caught("v := (now() at time zone 'Europe/Paris')::date;")).toEqual([]);
  expect(caught("v := (now() at time zone v_tz)::date;")).toEqual([]);
  expect(caught("v := ((now() at time zone 'UTC') - interval '12 hours')::date;")).toEqual([]);
  expect(caught("where (t.created_at at time zone 'Europe/Paris')::date = d")).toEqual([]);
  expect(caught("v := (v_today + 1)::timestamp at time zone v_tz;")).toEqual([]);
  expect(caught("order by coalesce(t.due_at, t.due_date::timestamp at time zone z)")).toEqual([]);
  expect(caught("v := now()::timestamptz; w := now()::timestamp with time zone; x := now()::text;")).toEqual([]);
  expect(caught("select extract(epoch from now() - d.stage_entered_at)")).toEqual([]);
  expect(caught("select date_part('epoch', now())")).toEqual([]);
  expect(caught("select extract(isodow from d), extract(day from w.today)")).toEqual([]);
  expect(caught("select date_trunc('day', now(), 'Europe/Paris')")).toEqual([]);
  expect(caught("select date_trunc('minute', now())")).toEqual([]);
  expect(caught("select date_trunc('day', now() at time zone 'UTC')")).toEqual([]);
  expect(caught("select date_trunc('month', v_today::timestamp)")).toEqual([]);
  expect(caught("v := '2026-10-16'::date; w := v_due_date::date;")).toEqual([]);
  expect(caught("-- current_date in a comment\nselect 1; /* now()::date /* nested */ current_time */")).toEqual([]);
  expect(caught("raise exception 'no current_date or now()::date here' using hint = 'x';")).toEqual([]);
  expect(caught("select 'it''s current_date'")).toEqual([]);
  expect(caught("select my_current_date, current_timestamp, localtimestamp_x from t")).toEqual([]);
  expect(caught("select '--' || current_date")).toEqual(["current_date"]);
});
