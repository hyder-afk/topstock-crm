#!/usr/bin/env node
// Database budget table (db-budgets workflow). Reads the logs of scripts/db-perf.sh and of the stock sheet import block
// (supabase/tests/perf_*.sql, perf_queue_concurrency.sh, stock_concurrency.sh perf), finds every timing or size that
// states its budget, and prints a compact Markdown table: label | measured | budget | result. Lines that mention a
// budget but cannot be read unambiguously are listed under the table, never dropped; plan headers and SQL text echoed
// by auto_explain are counted. Exit code: 0 every budget met, 1 a measure over its budget or an "OVER BUDGET" line,
// 2 a log missing or unreadable, or no budget line found at all (an empty table never passes).
//
// What is compared (the budgets of the design documents):
//   label : 12.3 ms (budget 10 ms)                       the one value on the line
//   TIMING label : p95 x ms, avg y ms (budget z ms)      p95 (perf_inventory, perf_sales, perf_share)
//   TIMING label (budget z ms) : avg x ms, max y ms      the average (perf_stock I5, I7, I17: budgets are on averages)
//   label : a x ms, b y ms (budget 15 / 18 ms)           in order: a against 15, b against 18 (perf_day5 P5:
//                                                        log_activity <= 15, undo_activity <= 18, design.md 1407)
//   label: wall clock x ms; p95 y ms (...) (budget z ms) p95 (stock_concurrency I16)
//   SIZE label : n bytes (budget 153,600)                bytes (perf_share I10)
//   === header (budget 10 ms each) ===  then  label : x ms     the header budget, for each line after it (perf_files)
//   TIMING label (budget 1,500 ms each, 30 s in all):  then psql "Time: x ms" lines (perf_stock_import I12 to I14):
//                                                        the slowest call against "each", their sum against "in all"
//                                                        (a Time line right after another one is the \gexec query
//                                                        itself, not a call, and is left out)
//   ... (baseline) / no design budget                    informational rows, never a miss
// Usage: node scripts/db-budget-table.mjs <log> [<log> ...]
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const NUM = String.raw`\d[\d,]*(?:\.\d+)?`;
const PSQL_PREFIX = /^psql:.*?:\d+: (?:NOTICE|INFO|WARNING|ERROR):\s+/;
const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s/;
const BUDGET_CLAUSE = /\(budget\s+([^)]*)\)/gi;
const MEASURE = new RegExp(String.raw`^(.*?)\s*(${NUM})\s*(ms|bytes)\b`);
const PSQL_TIME = new RegExp(String.raw`^Time:\s+(${NUM})\s*ms\b`);
const SECTION_ROW = new RegExp(String.raw`^(\S.*?)\s+:\s+(${NUM})\s*ms\s*$`);
const OVER_BUDGET = /over budget/i;
const MAX_LISTED = 100;

/** "1,500" -> 1500 */
export function toNumber(text) {
  return Number(String(text).replace(/,/g, ""));
}

/** Format a number for the table: up to 2 decimals, thousands with a comma ("1,500", "3.21"). */
export function formatNumber(n) {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** The line without the psql "psql:file:line: NOTICE:  " prefix or an Actions timestamp, trimmed. */
export function stripPrefix(raw) {
  return raw.replace(TIMESTAMP_PREFIX, "").replace(PSQL_PREFIX, "").trim();
}

/**
 * Reads the inside of "(budget ...)": "10 ms", "1,500 ms", "15 / 18 ms", "153,600", "45 ms; 3 new leads",
 * "10 ms each", "1,500 ms each, 30 s in all". Returns null when it does not start with a number.
 */
export function parseBudgetClause(inner) {
  const m = new RegExp(String.raw`^\s*(${NUM})\s*(?:\/\s*(${NUM})\s*)?(ms|s|bytes)?\b(.*)$`, "i").exec(inner);
  if (!m) return null;
  const unit = m[3] ? m[3].toLowerCase() : null;
  const rest = m[4] ?? "";
  const values = [toNumber(m[1])];
  if (m[2] !== undefined) values.push(toNumber(m[2]));
  const each = /\beach\b/i.test(rest);
  const all = new RegExp(String.raw`(${NUM})\s*(ms|s)\s+in all`, "i").exec(rest);
  return {
    values,
    unit,
    each,
    total: all ? { value: toNumber(all[1]), unit: all[2].toLowerCase() } : null,
    text: inner.trim(),
  };
}

/** "label : value part" or "label: value part"; null when the line has neither. */
function splitLabel(line) {
  let i = line.indexOf(" : ");
  if (i >= 0) return { label: line.slice(0, i), value: line.slice(i + 3) };
  i = line.indexOf(": ");
  if (i >= 0) return { label: line.slice(0, i), value: line.slice(i + 2) };
  return null;
}

/** Each "name x ms" / "x bytes" in a value part (segments split on ", " or "; "; "1,500" has no space). */
export function measures(valuePart) {
  const out = [];
  for (const segment of valuePart.split(/[,;]\s+/)) {
    const m = MEASURE.exec(segment.trim());
    if (m) out.push({ name: m[1].trim(), value: toNumber(m[2]), text: m[2], unit: m[3] });
  }
  return out;
}

function cleanLabel(label) {
  return label
    .replace(BUDGET_CLAUSE, "")
    .replace(/^(TIMING|SIZE)\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Budget in the measure's unit (s -> ms); null when the units cannot be compared. */
function budgetIn(value, budgetUnit, measureUnit) {
  if (!budgetUnit || budgetUnit === measureUnit) return value;
  if (budgetUnit === "s" && measureUnit === "ms") return value * 1000;
  return null;
}

function budgetText(value, unit) {
  return `${formatNumber(value)} ${unit}`;
}

function measuredText(m) {
  return `${m.name ? `${m.name} ` : ""}${formatNumber(m.value)} ${m.unit}`;
}

/** Why a line is not a measurement (plan headers and SQL text that quote a label holding "(budget ...)"). */
export function noiseKind(line) {
  if (/^PLAN\s.*\brun\s+\d+\s*$/.test(line)) return "PLAN header lines";
  if (/^Query Text:/i.test(line) || /'[^']*\(budget[^']*'/i.test(line)) return "SQL text lines (auto_explain)";
  return null;
}

/**
 * Parses one log. Returns { rows, unreadable, noise, overBudget }:
 *   rows        { file, line, label, measured, budget, status: "OK" | "MISS" | "info" }
 *   unreadable  { file, line, text, reason }  lines that mention a budget but could not be read
 *   noise       { [kind]: count }
 *   overBudget  { file, line, text }          lines that say "OVER BUDGET" themselves
 */
export function parseLog(text, file = "log") {
  const rows = [];
  const unreadable = [];
  const noise = {};
  const overBudget = [];
  const lines = text.split(/\r?\n/);
  /** @type {null | {budget: any, label: string, at: number, rows: number}} */
  let section = null; // "=== ... (budget 10 ms each) ===": applies to the "label : x ms" lines after it
  /** @type {null | {budget: any, label: string, at: number, times: number[], skipped: number}} */
  let timer = null; // "TIMING label (budget ...):": collects the psql "Time:" lines after it

  const add = (at, label, m, budget, unit) => {
    const limit = budgetIn(budget, unit, m.unit);
    if (limit === null) {
      unreadable.push({ file, line: at, text: lines[at - 1].trim(), reason: `budget unit ${unit} vs measured ${m.unit}` });
      return;
    }
    rows.push({
      file,
      line: at,
      label,
      measured: measuredText(m),
      budget: budgetText(budget, unit ?? m.unit),
      status: m.value > limit ? "MISS" : "OK",
    });
  };
  const closeSection = () => {
    if (section && section.rows === 0) {
      unreadable.push({ file, line: section.at, text: section.label, reason: "header budget, but no timing line after it" });
    }
    section = null;
  };
  const closeTimer = () => {
    if (!timer) return;
    const { budget, label, at, times } = timer;
    timer = null;
    if (times.length === 0) {
      unreadable.push({ file, line: at, text: label, reason: "no psql Time: line after it" });
      return;
    }
    const name = cleanLabel(label.replace(/:\s*$/, ""));
    const slowest = Math.max(...times);
    const sum = times.reduce((a, b) => a + b, 0);
    if (times.length === 1) {
      add(at, name, { name: "", value: slowest, unit: "ms" }, budget.values[0], budget.unit);
    } else if (budget.each) {
      add(at, `${name}, slowest of ${times.length} calls`, { name: "", value: slowest, unit: "ms" }, budget.values[0], budget.unit);
    } else {
      unreadable.push({ file, line: at, text: label, reason: `${times.length} Time: lines and no "each" budget` });
    }
    if (budget.total && times.length > 0) {
      add(at, `${name}, all ${times.length} calls`, { name: "sum", value: sum, unit: "ms" }, budget.total.value, budget.total.unit);
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const at = i + 1;
    const line = stripPrefix(lines[i]);
    if (!line) continue;
    if (OVER_BUDGET.test(line)) overBudget.push({ file, line: at, text: line });

    if (timer) {
      const t = PSQL_TIME.exec(line);
      if (t) {
        // psql \gexec prints the generating query's own Time right after the last call's Time: not a call.
        if (PSQL_TIME.test(stripPrefix(lines[i - 1] ?? ""))) timer.skipped++;
        else timer.times.push(toNumber(t[1]));
        continue;
      }
      if (/^(TIMING\b|===)/.test(line)) closeTimer();
    }
    if (line.startsWith("===")) closeSection();

    const mentionsBudget = /budget/i.test(line);
    const isBaseline = /\(baseline\)|no design budget/i.test(line);

    if (section && !mentionsBudget) {
      const r = SECTION_ROW.exec(line);
      if (r) {
        section.rows++;
        add(at, cleanLabel(r[1]), { name: "", value: toNumber(r[2]), unit: "ms" }, section.budget.values[0], section.budget.unit);
        continue;
      }
      if (section.rows > 0) closeSection();
    }

    if (!mentionsBudget && !isBaseline) continue;
    const kind = noiseKind(line);
    if (kind) {
      noise[kind] = (noise[kind] ?? 0) + 1;
      continue;
    }

    const clauses = [...line.matchAll(BUDGET_CLAUSE)].map((c) => parseBudgetClause(c[1]));
    const fail = (reason) => unreadable.push({ file, line: at, text: line, reason });

    // Headers: "=== ... (budget 10 ms each) ===" and "TIMING label (budget ...):".
    if (line.startsWith("===")) {
      if (clauses.length === 1 && clauses[0]) section = { budget: clauses[0], label: line, at, rows: 0 };
      else if (mentionsBudget) fail("header budget not readable");
      continue;
    }
    if (/^TIMING\b.*\(budget[^)]*\)\s*:\s*$/i.test(line)) {
      if (clauses.length === 1 && clauses[0]) timer = { budget: clauses[0], label: line, at, times: [], skipped: 0 };
      else fail("timing header budget not readable");
      continue;
    }

    const parts = splitLabel(line);
    if (!parts) {
      if (mentionsBudget && !OVER_BUDGET.test(line)) fail("no 'label : value' split");
      continue;
    }
    const label = cleanLabel(parts.label);
    const found = measures(parts.value.replace(BUDGET_CLAUSE, ""));

    if (clauses.length === 0) {
      // Baseline / no design budget: informational, never a miss.
      if (isBaseline && found.length > 0) {
        for (const m of found) {
          rows.push({ file, line: at, label: m.name ? `${label}, ${m.name}` : label, measured: `${formatNumber(m.value)} ${m.unit}`, budget: "baseline", status: "info" });
        }
      } else if (mentionsBudget && !OVER_BUDGET.test(line)) fail("mentions a budget without a number");
      continue;
    }
    if (clauses.length > 1 || !clauses[0]) {
      fail(clauses.length > 1 ? "more than one budget on the line" : "budget not readable");
      continue;
    }
    const b = clauses[0];
    if (b.values.length === 2) {
      if (found.length !== 2) {
        fail(`two budgets (a / b) but ${found.length} measured values`);
        continue;
      }
      found.forEach((m, k) => add(at, m.name ? `${label}, ${m.name}` : label, { ...m, name: "" }, b.values[k], b.unit));
      continue;
    }
    const pick =
      found.find((m) => m.name === "p95") ??
      found.find((m) => m.name === "avg" || m.name === "average") ??
      (found.length === 1 ? found[0] : undefined);
    if (!pick) {
      fail(found.length === 0 ? "no measured value" : `${found.length} measured values, none named p95 or avg`);
      continue;
    }
    add(at, label, pick, b.values[0], b.unit);
  }
  closeTimer();
  closeSection();
  return { file, rows, unreadable, noise, overBudget };
}

function escapeCell(text) {
  return String(text).replace(/\|/g, "\\|").replace(/`/g, "'");
}

/** Merges several parsed logs and renders the Markdown report. */
export function render(results, missing = []) {
  const rows = results.flatMap((r) => r.rows);
  const unreadable = results.flatMap((r) => r.unreadable);
  const overBudget = results.flatMap((r) => r.overBudget);
  const noise = {};
  for (const r of results) for (const [k, n] of Object.entries(r.noise)) noise[k] = (noise[k] ?? 0) + n;
  const judged = rows.filter((r) => r.status !== "info");
  const misses = judged.filter((r) => r.status === "MISS");
  const out = [];
  out.push(
    `**${judged.length} budgets checked: ${judged.length - misses.length} OK, ${misses.length} missed**` +
      `${rows.length > judged.length ? ` (${rows.length - judged.length} informational)` : ""}` +
      `${overBudget.length ? `; ${overBudget.length} "OVER BUDGET" line(s)` : ""}.`,
  );
  out.push("");
  out.push(
    "Measured: p95 where a line gives p95 and avg; the average where it gives avg and max (I5, I7, I17); " +
      '"budget a / b" pairs a and b with the two values in order (P5); I12 to I14: the slowest psql call against ' +
      '"each", the sum against "in all".',
  );
  out.push("");
  for (const r of results) {
    out.push(`#### ${escapeCell(r.file)}`);
    out.push("");
    out.push("| Label | Measured | Budget | Result |");
    out.push("|---|--:|--:|:-:|");
    for (const row of r.rows) {
      const result = row.status === "MISS" ? "**MISS**" : row.status;
      out.push(`| ${escapeCell(row.label)} | ${row.measured} | ${escapeCell(row.budget)} | ${result} |`);
    }
    if (r.rows.length === 0) out.push("| (no budget line found) | | | |");
    out.push("");
  }
  if (missing.length) {
    out.push(`**Logs missing or unreadable (${missing.length}):** ${missing.map((m) => `\`${escapeCell(m)}\``).join(", ")}`);
    out.push("");
  }
  if (overBudget.length) {
    out.push(`**Lines that say OVER BUDGET (${overBudget.length}):**`);
    for (const o of overBudget.slice(0, MAX_LISTED)) out.push(`- \`${escapeCell(o.file)}:${o.line}\` ${escapeCell(o.text.slice(0, 200))}`);
    if (overBudget.length > MAX_LISTED) out.push(`- ... and ${overBudget.length - MAX_LISTED} more (see the log artifact)`);
    out.push("");
  }
  out.push(`**Lines that mention a budget but could not be read (${unreadable.length}):**${unreadable.length ? "" : " none."}`);
  for (const u of unreadable.slice(0, MAX_LISTED)) {
    out.push(`- \`${escapeCell(u.file)}:${u.line}\` ${escapeCell(u.text.slice(0, 200))} (${u.reason})`);
  }
  if (unreadable.length > MAX_LISTED) out.push(`- ... and ${unreadable.length - MAX_LISTED} more (see the log artifact)`);
  const noiseKinds = Object.entries(noise);
  if (noiseKinds.length) {
    out.push("");
    out.push(`Not measurements, skipped: ${noiseKinds.map(([k, n]) => `${n} ${k}`).join(", ")}.`);
  }
  const code = misses.length || overBudget.length ? 1 : missing.length || judged.length === 0 ? 2 : 0;
  return { markdown: `${out.join("\n")}\n`, code, rows, unreadable, misses, overBudget };
}

// Run as a script (not imported by the unit test). No import.meta: the unit test loads this file through Playwright's
// CommonJS transform.
if (process.argv[1]?.endsWith("db-budget-table.mjs")) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("Usage: node scripts/db-budget-table.mjs <log> [<log> ...]");
    process.exit(2);
  }
  const results = [];
  const missing = [];
  for (const f of files) {
    try {
      results.push(parseLog(readFileSync(f, "utf8"), basename(f)));
    } catch {
      missing.push(basename(f));
    }
  }
  const report = render(results, missing);
  process.stdout.write(report.markdown);
  process.exit(report.code);
}
