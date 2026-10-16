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
// databases that ran it). A finding inside a function that a later migration redefines (`create or replace function`
// with the same name) is not live any more: the later body is what runs, and it is checked in its own file. That is how
// a fix lands (20261022130000 redefines private.share_take with the Paris day). The live findings left in applied
// migrations are listed below with the reason each one is acceptable; a new migration that needs one of these patterns
// should use the explicit-zone form instead of growing this list.
const dir = join(__dirname, "../../supabase/migrations");
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

type Hit = { line: number; expr: string; fn: string | null };

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

const DEFINE = /\bcreate\s+(or\s+replace\s+)?function\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\s*\(/gi;

// Type spellings PostgreSQL treats as the same type, so `int` and `integer` name one signature.
const TYPE_ALIASES: Record<string, string> = {
  int: "integer", int4: "integer", int2: "smallint", int8: "bigint", bool: "boolean", float8: "double precision",
  float4: "real", varchar: "character varying", timestamptz: "timestamp with time zone",
  timestamp: "timestamp without time zone", timetz: "time with time zone", time: "time without time zone",
};
// Types written in more than one word: an argument that starts with one of these has no name in front.
const MULTIWORD = /^(double\s+precision|timestamp\s+with(out)?\s+time\s+zone|time\s+with(out)?\s+time\s+zone|character\s+varying|bit\s+varying)\b/i;

// One argument's type, as PostgreSQL's identity signature has it: no mode, no name, no default; lower case, single
// spaces, aliases folded. OUT arguments are not part of the identity, so they give null.
function argType(arg: string): string | null {
  let text = arg.replace(/\s+(default\b|=)[\s\S]*$/i, "").trim().replace(/\s+/g, " ").toLowerCase();
  const mode = /^(in|out|inout|variadic) /.exec(text);
  if (mode) text = text.slice(mode[0].length);
  if (mode?.[1] === "out") return null;
  if (!MULTIWORD.test(text) && text.includes(" ")) text = text.slice(text.indexOf(" ") + 1);
  text = text.replace(/\s*([(),])\s*/g, "$1");
  const bare = text.replace(/\(.*\)$/, "");
  const alias = TYPE_ALIASES[bare];
  return alias ? alias + text.slice(bare.length) : text;
}

// The key of a function: schema-qualified name plus its argument types, e.g. "private.share_take(uuid,text)".
function signature(name: string, argList: string): string {
  // String defaults are emptied first, so a comma or parenthesis inside one cannot split an argument.
  const list = argList.replace(/'(?:[^']|'')*'/g, "''");
  const types = list.trim() ? args(list).map(argType).filter((t): t is string => t !== null) : [];
  return `${name.toLowerCase()}(${types.join(",")})`;
}

// Each function defined in the file: its signature and the span from `create` to the end of its dollar-quoted body.
function definitions(code: string): Array<{ fn: string; from: number; to: number; replaces: boolean }> {
  const out: Array<{ fn: string; from: number; to: number; replaces: boolean }> = [];
  for (const m of code.matchAll(DEFINE)) {
    const paren = m.index + m[0].length - 1;
    const argsEnd = closing(code, paren);
    const open = /\$([a-z_]*)\$/i.exec(code.slice(argsEnd));
    if (!open) continue;
    const tag = open[0];
    const bodyStart = argsEnd + open.index + tag.length;
    const close = code.indexOf(tag, bodyStart);
    out.push({
      fn: signature(m[2], code.slice(paren + 1, argsEnd)),
      from: m.index,
      to: close === -1 ? code.length : close + tag.length,
      replaces: !!m[1],
    });
  }
  return out;
}

function findLocalDates(sql: string): Hit[] {
  const { code, strings } = scrub(sql);
  const inString = (at: number) => strings.some(([a, b]) => at >= a && at <= b);
  const lineOf = (at: number) => code.slice(0, at).split("\n").length;
  const defs = definitions(code);
  const fnAt = (at: number) => defs.find((d) => at >= d.from && at < d.to)?.fn ?? null;
  const hits: Array<Hit & { at: number }> = [];
  const add = (at: number, expr: string) => {
    if (!inString(at)) hits.push({ at, line: lineOf(at), expr: norm(expr), fn: fnAt(at) });
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

  return hits.sort((a, b) => a.at - b.at).map(({ line, expr, fn }) => ({ line, expr, fn }));
}

// The later migration that redefines this function (same name and argument types), if any: the finding no longer runs.
// An overload with other argument types is another function and supersedes nothing.
const redefined = new Map(files.map((f) => [f, definitions(scrub(readFileSync(join(dir, f), "utf8")).code)]));
function supersededBy(file: string, fn: string | null, order: string[] = files, defs = redefined): string | null {
  if (!fn) return null;
  return order.find((later) => later > file && (defs.get(later) ?? []).some((d) => d.replaces && d.fn === fn)) ?? null;
}

// Reviewed findings in migrations that are already applied (see the header). Each entry is file, line and the
// expression as the check prints it (whitespace collapsed).
const BOUNDS =
  "A sanity bound years wide (it only refuses absurd dates); in another session zone the bound moves by at most one " +
  "day at its far edge, which changes nothing a person can do. Applied migration: not edited.";
const ALLOWED: Array<{ file: string; line: number; expr: string; reason: string }> = [
  // A task's due date within five years, in private.task_guard as Day 6 last redefined it (the earlier definitions in
  // 20261011120000 and 20261015090000 are superseded).
  { file: "20261019090000_sales_requests.sql", line: 792, expr: "(now() - interval '5 years')::date", reason: BOUNDS },
  { file: "20261019090000_sales_requests.sql", line: 792, expr: "(now() + interval '5 years')::date", reason: BOUNDS },
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
];

test("there are migrations to check", () => {
  expect(files.length).toBeGreaterThan(10);
  expect(files).toContain("20261015090000_deals_pipeline.sql");
});

for (const file of files) {
  test(`${file}: no date or time of day taken in the session's time zone`, () => {
    const found = findLocalDates(readFileSync(join(dir, file), "utf8"));
    const unexplained = found.filter(
      (h) => !supersededBy(file, h.fn) && !ALLOWED.some((a) => a.file === file && a.line === h.line && a.expr === h.expr),
    );
    expect(
      unexplained.map((h) => `${file}:${h.line}  ${h.expr}`),
      "use `(now() at time zone 'Europe/Paris')::date` (or the zone in hand), never the session's zone",
    ).toEqual([]);
  });
}

test("every allowlisted finding is still there and still live, with a reason", () => {
  for (const a of ALLOWED) {
    expect(files, `${a.file} exists`).toContain(a.file);
    expect(a.reason.length, `${a.file}:${a.line} has a reason`).toBeGreaterThan(40);
    const hit = findLocalDates(readFileSync(join(dir, a.file), "utf8")).find((h) => h.line === a.line && h.expr === a.expr);
    expect(hit, `${a.file}:${a.line} ${a.expr} is still found`).toBeTruthy();
    expect(supersededBy(a.file, hit?.fn ?? null), `${a.file}:${a.line} is superseded: drop the entry`).toBeNull();
  }
});

test("share_take's session-zone buckets are fixed by a later migration, not allowlisted", () => {
  const old = findLocalDates(readFileSync(join(dir, "20261020090000_client_share.sql"), "utf8")).filter((h) => h.fn === "private.share_take(uuid,text)");
  expect(old.map((h) => h.expr)).toEqual(["date_trunc('hour', now())", "date_trunc('day', now())"]);
  expect(supersededBy("20261020090000_client_share.sql", "private.share_take(uuid,text)")).toBe("20261022130000_share_take_paris_day.sql");
  expect(findLocalDates(readFileSync(join(dir, "20261022130000_share_take_paris_day.sql"), "utf8"))).toEqual([]);
  expect(ALLOWED.filter((a) => a.file === "20261020090000_client_share.sql" && a.line >= 630 && a.line <= 667)).toEqual([]);
});

test("the check itself: a later create or replace of the same signature supersedes; another name or overload does not", () => {
  const defs = new Map([
    ["1_a.sql", definitions("create function x.f() returns int language sql as $$ select 1 $$;\n" +
      "create function x.h(p_n int, p_at timestamptz default now()) returns int language sql as $$ select 1 $$;\n" +
      "create function x.k(int) returns int language sql as $$ select 1 $$;")],
    ["2_b.sql", definitions("create or replace function x.f() returns int language sql as $q$ select 2 $q$;\n" +
      "create function x.g() returns int language sql as $$ select 3 $$;\n" +
      "create or replace function x.h(n  INTEGER, at timestamp with time zone = now()) returns int language sql as $$ select 4 $$;\n" +
      "create or replace function x.k(text) returns int language sql as $$ select 5 $$;")],
  ]);
  const order = ["1_a.sql", "2_b.sql"];
  expect(defs.get("1_a.sql")!.map((d) => d.fn)).toEqual(["x.f()", "x.h(integer,timestamp with time zone)", "x.k(integer)"]);
  expect(supersededBy("1_a.sql", "x.f()", order, defs)).toBe("2_b.sql");
  expect(supersededBy("1_a.sql", "x.g()", order, defs)).toBeNull();
  expect(supersededBy("2_b.sql", "x.f()", order, defs)).toBeNull();
  expect(supersededBy("1_a.sql", null, order, defs)).toBeNull();
  // Same types written differently (names, case, spaces, aliases, defaults): the same function.
  expect(supersededBy("1_a.sql", "x.h(integer,timestamp with time zone)", order, defs)).toBe("2_b.sql");
  // x.f(int) and x.f(text) are two functions: replacing the text one leaves the int one live.
  expect(supersededBy("1_a.sql", "x.k(integer)", order, defs)).toBeNull();
  expect(signature("x.f", "int")).not.toBe(signature("x.f", "text"));
  expect(signature("x.f", "in p_a int, out p_b text, variadic p_c text[]")).toBe("x.f(integer,text[])");
  expect(signature("x.f", "p_n numeric(12, 2) default 0, p_v character varying(20)")).toBe("x.f(numeric(12,2),character varying(20))");
  expect(signature("x.f", "p_sep text default ', (', p_n int")).toBe("x.f(text,integer)");
  const hits = findLocalDates("create function x.f() returns date language sql as $$ select current_date $$;\nselect localtime;");
  expect(hits).toEqual([
    { line: 1, expr: "current_date", fn: "x.f()" },
    { line: 2, expr: "localtime", fn: null },
  ]);
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
