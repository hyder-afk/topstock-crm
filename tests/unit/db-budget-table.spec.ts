import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { budgetId, parseBudgetClause, parseLog, render, REQUIRED, stripPrefix } from "../../scripts/db-budget-table.mjs";

// Sample lines copied from a local run of scripts/db-perf.sh and the workflow's stock import block (fake data only),
// one or more per output format of supabase/tests/perf_*.sql, perf_queue_concurrency.sh and stock_concurrency.sh perf.
// The psql prefix carries a folder named "...-budgets" on purpose: the word in the path must not count as a budget.
const P = (file: string, line: number) => `psql:/home/user/topstock-crm-budgets/supabase/tests/${file}:${line}: NOTICE:  `;
const SCRIPT = path.join(__dirname, "../../scripts/db-budget-table.mjs");

// One OK line per required row: a log a complete run could print (the P5 rows come two to a line).
const completeLog = () =>
  Object.entries(REQUIRED)
    .flatMap(([id, n]) =>
      id === "P5"
        ? Array.from({ length: n / 2 }, (_, k) => `Lead ${k}, with a deal : log_activity 9.46 ms, undo_activity 6.55 ms (budget 15 / 18 ms)`)
        : Array.from({ length: n }, (_, k) => `${id} case ${k} : 1.00 ms (budget 5 ms)`),
    )
    .join("\n");
const rowsOf = (text: string) => parseLog(text, "t.log").rows.map((r) => [r.label, r.measured, r.budget, r.status]);

test.describe("budget clause", () => {
  test("numbers with commas, units, a / b, each, in all", () => {
    expect(parseBudgetClause("1,500 ms")).toMatchObject({ values: [1500], unit: "ms", each: false, total: null });
    expect(parseBudgetClause("153,600")).toMatchObject({ values: [153600], unit: null });
    expect(parseBudgetClause("15 / 18 ms")).toMatchObject({ values: [15, 18], unit: "ms" });
    expect(parseBudgetClause("45 ms; 2000 new leads")).toMatchObject({ values: [45], unit: "ms" });
    expect(parseBudgetClause("10 ms each")).toMatchObject({ values: [10], each: true });
    expect(parseBudgetClause("1,500 ms each, 30 s in all")).toMatchObject({
      values: [1500],
      each: true,
      total: { value: 30, unit: "s" },
    });
    expect(parseBudgetClause("soon")).toBeNull();
  });

  test("prefixes: psql notice and an Actions timestamp", () => {
    expect(stripPrefix(`${P("perf_day5.sql", 263)}P6 list_lead_deals : 2.29 ms (budget 3 ms) 1 rows`)).toBe(
      "P6 list_lead_deals : 2.29 ms (budget 3 ms) 1 rows",
    );
    expect(stripPrefix("2026-10-16T09:12:01.1234567Z I16 x: wall clock 1 ms (budget 3,000 ms)")).toBe(
      "I16 x: wall clock 1 ms (budget 3,000 ms)",
    );
  });
});

test.describe("perf_day5.sql", () => {
  test("label : x ms (budget y ms) with text after the clause; over budget is a MISS", () => {
    const log = [
      `${P("perf_day5.sql", 263)}P1 pipeline_board team (admin, 50 a column)    : 16.48 ms (budget 25 ms) 2000 open, 50 cards in Lead`,
      `${P("perf_day5.sql", 263)}P1 pipeline_board mine (rep)                   : 20.60 ms (budget 15 ms) 1000 open`,
      `${P("perf_day5.sql", 263)}P3 pipeline_summary team                       : 5.80 ms (budget 10 ms) stalled 180/120/100`,
      `${P("perf_day5.sql", 290)}P4b update_deal                                : 6.00 ms (budget 6 ms)`,
      `${P("perf_day5.sql", 514)}P7 home_summary team, import week              : 32.83 ms (budget 45 ms; 30015 new leads)`,
    ].join("\n");
    expect(rowsOf(log)).toEqual([
      ["P1 pipeline_board team (admin, 50 a column)", "16.48 ms", "25 ms", "OK"],
      ["P1 pipeline_board mine (rep)", "20.6 ms", "15 ms", "MISS"],
      ["P3 pipeline_summary team", "5.8 ms", "10 ms", "OK"],
      ["P4b update_deal", "6 ms", "6 ms", "OK"],
      ["P7 home_summary team, import week", "32.83 ms", "45 ms", "OK"],
    ]);
  });

  test("budget 15 / 18 ms: log_activity against 15, undo_activity against 18 (not the larger for both)", () => {
    const log = [
      `${P("perf_day5.sql", 407)}The lead with 10,008 entries, with a deal    : log_activity 9.46 ms, undo_activity 6.55 ms (budget 15 / 18 ms)`,
      `${P("perf_day5.sql", 407)}A typical lead, with a deal                  : log_activity 16.20 ms, undo_activity 17.95 ms (budget 15 / 18 ms)`,
    ].join("\n");
    expect(rowsOf(log)).toEqual([
      ["The lead with 10,008 entries, with a deal, log_activity", "9.46 ms", "15 ms", "OK"],
      ["The lead with 10,008 entries, with a deal, undo_activity", "6.55 ms", "18 ms", "OK"],
      ["A typical lead, with a deal, log_activity", "16.2 ms", "15 ms", "MISS"],
      ["A typical lead, with a deal, undo_activity", "17.95 ms", "18 ms", "OK"],
    ]);
  });

  test("baseline lines are informational, never a miss", () => {
    const log = `${P("perf_day5.sql", 407)}A typical lead, no deal                      : log_activity 96.94 ms, undo_activity 4.91 ms (baseline)`;
    const parsed = parseLog(log, "t.log");
    expect(rowsOf(log)).toEqual([
      ["A typical lead, no deal, log_activity", "96.94 ms", "baseline", "info"],
      ["A typical lead, no deal, undo_activity", "4.91 ms", "baseline", "info"],
    ]);
    expect(render([parsed]).code).toBe(2); // informational rows alone: nothing was judged
  });

  test("lines without the word budget are not judged (perf_leads, perf_day4, perf_import, the 4c P5 note)", () => {
    const log = [
      `${P("perf_leads.sql", 121)}first page, last activity (default)              : 3.2 ms`,
      `${P("perf_day4.sql", 163)}P2 first page, lead with 10,008 entries : 1.10 ms (50 rows)`,
      `${P("perf_import.sql", 72)}P1 add rows: 30 calls, average 48.0 ms, slowest 62.9 ms, total 1440 ms`,
      `${P("perf_day5.sql", 488)}   Today: list_tasks overdue + today (rep)     : 3.73 ms (4c P5: 15 ms)`,
      "P10 claims: 300 (leads served: 300), p50 4.1 ms, p95 9.8 ms, max 20.2 ms",
    ].join("\n");
    const parsed = parseLog(log, "t.log");
    expect(parsed.rows).toEqual([]);
    expect(parsed.unreadable).toEqual([]);
  });
});

test.describe("p95 and avg formats", () => {
  test("perf_inventory: TIMING label : p95, avg (budget) compares p95", () => {
    const log = [
      `${P("perf_inventory.sql", 107)}TIMING I1 list_stock sort name                : p95 3.53 ms, avg 3.23 ms (budget 20 ms)`,
      `${P("perf_inventory.sql", 107)}TIMING I1 list_stock sort available           : p95 22.68 ms, avg 19.10 ms (budget 20 ms)`,
      `${P("perf_inventory.sql", 107)}TIMING I1 list_stock search "product 12"      : p95 4.32 ms, avg 3.90 ms (budget 20 ms)`,
    ].join("\n");
    expect(rowsOf(log)).toEqual([
      ["I1 list_stock sort name", "p95 3.53 ms", "20 ms", "OK"],
      ["I1 list_stock sort available", "p95 22.68 ms", "20 ms", "MISS"],
      ['I1 list_stock search "product 12"', "p95 4.32 ms", "20 ms", "OK"],
    ]);
  });

  test("perf_sales and perf_share: the budget sits in the label, before the value", () => {
    const log = [
      `${P("perf_sales.sql", 196)}TIMING I6 record_sale 1 line (budget 10 ms)     : p95 8.07 ms, avg 6.71 ms`,
      `${P("perf_sales.sql", 196)}TIMING I6 record_sale 20 lines (budget 40 ms)   : p95 41.51 ms, avg 38.20 ms`,
      `${P("perf_sales.sql", 196)}TIMING list_sales page 1, all leads             : p95 5.10 ms, avg 4.80 ms`,
      `${P("perf_share.sql", 101)}TIMING I9 share_view valid, 2,000 items (budget 40 ms)  : p95 30.05 ms, avg 26.65 ms`,
      `${P("perf_share.sql", 101)}TIMING I9 share_view malformed token (budget 1 ms)      : p95 0.01 ms, avg 0.01 ms`,
    ].join("\n");
    expect(rowsOf(log)).toEqual([
      ["I6 record_sale 1 line", "p95 8.07 ms", "10 ms", "OK"],
      ["I6 record_sale 20 lines", "p95 41.51 ms", "40 ms", "MISS"],
      ["I9 share_view valid, 2,000 items", "p95 30.05 ms", "40 ms", "OK"],
      ["I9 share_view malformed token", "p95 0.01 ms", "1 ms", "OK"],
    ]);
  });

  test("perf_stock: avg and max compares the average; 1,500 reads as 1500", () => {
    const log = [
      `${P("perf_stock.sql", 219)}TIMING I5 adjust_out (budget 5 ms)                    : avg 3.56 ms, max 6.26 ms`,
      `${P("perf_stock.sql", 219)}TIMING I5 transfer, Arrived 1 piece (budget 5 ms)     : avg 6.54 ms, max 6.85 ms`,
      `${P("perf_stock.sql", 246)}TIMING I17 check_stock_integrity (budget 1,500 ms)    : avg 154.7 ms, max 159.0 ms, 0 rows over 200006 ledger rows`,
    ].join("\n");
    expect(rowsOf(log)).toEqual([
      ["I5 adjust_out", "avg 3.56 ms", "5 ms", "OK"],
      ["I5 transfer, Arrived 1 piece", "avg 6.54 ms", "5 ms", "MISS"],
      ["I17 check_stock_integrity", "avg 154.7 ms", "1,500 ms", "OK"],
    ]);
  });

  test("stock_concurrency I16: wall clock against 3,000 ms; p95 (not the wall clock) against 25 ms", () => {
    const log = [
      "I16 twenty sessions holding the last pieces: wall clock 337 ms (budget 3,000 ms)",
      "I16 3 sessions x 300 mixed operations on 20 hot products: wall clock 1351 ms; p95 5.79 ms (of 837 applied) (budget 25 ms); refused 63; deadlocks 0",
      "I16 twenty sessions holding the last pieces: wall clock 3001 ms (budget 3,000 ms)",
    ].join("\n");
    expect(rowsOf(log)).toEqual([
      ["I16 twenty sessions holding the last pieces", "wall clock 337 ms", "3,000 ms", "OK"],
      ["I16 3 sessions x 300 mixed operations on 20 hot products", "p95 5.79 ms", "25 ms", "OK"],
      ["I16 twenty sessions holding the last pieces", "wall clock 3,001 ms", "3,000 ms", "MISS"],
    ]);
  });

  test("perf_share SIZE: bytes against a budget with no unit", () => {
    expect(rowsOf(`${P("perf_share.sql", 110)}SIZE I10 share_view raw : 125333 bytes (budget 153,600)`)).toEqual([
      ["I10 share_view raw", "125,333 bytes", "153,600 bytes", "OK"],
    ]);
    expect(rowsOf(`${P("perf_share.sql", 110)}SIZE I10 share_view raw : 160000 bytes (budget 153,600)`)[0][3]).toBe("MISS");
  });
});

test.describe("headers", () => {
  test("perf_files: the === header budget applies to each P11 line after it, and stops there", () => {
    const log = [
      "=== P11 timings: average of 5 warm rounds after 10, milliseconds (budget 10 ms each) ===",
      `${P("perf_files.sql", 99)}P11 take_stale_uploads : 0.66 ms`,
      `${P("perf_files.sql", 99)}P11 begin_file_upload  : 10.25 ms`,
      `${P("perf_files.sql", 99)}P11 finish_file_upload : 5.00 ms`,
      "I16 twenty sessions holding the last pieces: wall clock 337 ms (budget 3,000 ms)",
      "stock_concurrency (perf): integrity clean",
      "some later line : 12.00 ms",
    ].join("\n");
    expect(rowsOf(log)).toEqual([
      ["P11 take_stale_uploads", "0.66 ms", "10 ms", "OK"],
      ["P11 begin_file_upload", "10.25 ms", "10 ms", "MISS"],
      ["P11 finish_file_upload", "5 ms", "10 ms", "OK"],
      ["I16 twenty sessions holding the last pieces", "wall clock 337 ms", "3,000 ms", "OK"],
    ]);
  });

  test("a header budget with no timing line after it is listed as unreadable", () => {
    const parsed = parseLog("=== P11 timings: milliseconds (budget 10 ms each) ===\nperf_files: done", "t.log");
    expect(parsed.rows).toEqual([]);
    expect(parsed.unreadable).toEqual([expect.objectContaining({ line: 1, reason: expect.stringContaining("no timing line") })]);
  });

  test("perf_stock_import: psql Time lines after each TIMING header; \\gexec's own Time is not a call", () => {
    const calls = (values: string[]) => values.flatMap((v) => [" remaining ", "-----------", " 4875", "(1 row)", "", `Time: ${v}`]);
    const log = [
      "perf_stock: done",
      "TIMING I12 validate_stock_import 5,000 rows (budget 1,000 ms):",
      "  status  ",
      "----------",
      " dry_run",
      "(1 row)",
      "",
      "Time: 538.379 ms",
      "TIMING I13 commit_stock_import chunks of 125 (budget 1,500 ms each, 30 s in all):",
      ...calls(["973.900 ms", "1523.400 ms (00:01.523)", "2.857 ms"]),
      "Time: 0.431 ms",
      "                 ?column?                  ",
      "-------------------------------------------",
      " TIMING I13 status imported, 5000 products",
      "(1 row)",
      "",
      "TIMING I14 rollback_stock_import chunks of 125 (budget 1,500 ms each):",
      ...calls(["618.670 ms", "2.195 ms"]),
      "Time: 0.151 ms",
      " TIMING I14 status rolled_back, kept 0",
      " TIMING integrity rows after: 0",
    ].join("\n");
    expect(rowsOf(log)).toEqual([
      ["I12 validate_stock_import 5,000 rows", "538.38 ms", "1,000 ms", "OK"],
      ["I13 commit_stock_import chunks of 125, slowest of 3 calls", "1,523.4 ms", "1,500 ms", "MISS"],
      ["I13 commit_stock_import chunks of 125, all 3 calls", "sum 2,500.16 ms", "30 s", "OK"],
      ["I14 rollback_stock_import chunks of 125, slowest of 2 calls", "618.67 ms", "1,500 ms", "OK"],
    ]);
  });

  test("a TIMING header with no Time line after it is listed as unreadable", () => {
    const parsed = parseLog("TIMING I12 validate_stock_import 5,000 rows (budget 1,000 ms):\nERROR: boom", "t.log");
    expect(parsed.rows).toEqual([]);
    expect(parsed.unreadable).toEqual([expect.objectContaining({ reason: "no psql Time: line after it" })]);
  });
});

test.describe("unreadable lines, noise and exit codes", () => {
  test("lines that mention a budget but are ambiguous are listed, never dropped", () => {
    const log = [
      "X something : 3 ms, 4 ms (budget 5 ms)",
      "Y something : 3 ms (budget soon)",
      "Z something : log 3 ms (budget 5 / 6 ms)",
      "no split here (budget 5 ms)",
      "W : 3 ms (budget 5 ms) (budget 6 ms)",
      "V : 3 bytes (budget 5 ms)",
    ].join("\n");
    const parsed = parseLog(log, "t.log");
    expect(parsed.rows).toEqual([]);
    expect(parsed.unreadable.map((u) => u.line)).toEqual([1, 2, 3, 4, 5, 6]);
    const md = render([parsed]).markdown;
    expect(md).toContain("could not be read (6)");
    expect(md).toContain("`t.log:3` Z something : log 3 ms (budget 5 / 6 ms) (two budgets (a / b) but 1 measured values)");
  });

  test("PLAN headers and SQL text quoting a label are counted as noise, not unreadable", () => {
    const log = [
      `${P("perf_sales.sql", 181)}PLAN I6 record_sale 1 line (budget 10 ms) run 6`,
      `${P("perf_share.sql", 85)}PLAN I9 share_view valid, 2,000 items (budget 40 ms) run 7`,
      "  select (array['I6 record_sale 1 line (budget 10 ms)', 'I6 record_sale 10 lines (budget 25 ms)',",
      `${P("perf_day5.sql", 263)}P6 list_lead_deals                             : 2.29 ms (budget 3 ms) 1 rows`,
    ].join("\n");
    const parsed = parseLog(log, "t.log");
    expect(parsed.noise).toEqual({ "PLAN header lines": 2, "SQL text lines (auto_explain)": 1 });
    expect(parsed.unreadable).toEqual([]);
    expect(rowsOf(log)).toEqual([["P6 list_lead_deals", "2.29 ms", "3 ms", "OK"]]);
    expect(render([parsed]).markdown).toContain("Not measurements, skipped: 2 PLAN header lines, 1 SQL text lines (auto_explain).");
  });

  test("an OVER BUDGET line fails the run even when every parsed row is OK", () => {
    const parsed = parseLog(["P6 list_lead_deals : 2.29 ms (budget 3 ms)", "I13 chunk 7: OVER BUDGET (1,612 ms)"].join("\n"), "t.log");
    expect(parsed.overBudget).toEqual([{ file: "t.log", line: 2, text: "I13 chunk 7: OVER BUDGET (1,612 ms)" }]);
    expect(parsed.unreadable).toEqual([]);
    const report = render([parsed]);
    expect(report.code).toBe(1);
    expect(report.markdown).toContain("Lines that say OVER BUDGET (1)");
  });

  test("render: one table per log, MISS in bold; codes 0 / 1 / 2", () => {
    const ok = parseLog("P6 get_deal (50 history rows) : 4.61 ms (budget 5 ms)", "db-perf.log");
    const miss = parseLog("P4 move_deal win : 10.65 ms (budget 10 ms)", "stock-import-perf.log");
    const both = render([ok, miss]);
    expect(both.code).toBe(1);
    expect(both.markdown).toContain("**2 budgets checked: 1 OK, 1 missed**");
    expect(both.markdown).toContain("#### db-perf.log");
    expect(both.markdown).toContain("#### stock-import-perf.log");
    expect(both.markdown).toContain("| P4 move_deal win | 10.65 ms | 10 ms | **MISS** |");
    expect(render([ok], [], {}).code).toBe(0);
    expect(render([ok], ["stock-import-perf.log"], {}).code).toBe(2);
    expect(render([parseLog("nothing here", "empty.log")], [], {}).code).toBe(2);
    expect(render([parseLog("a | b : 1 ms (budget 2 ms)", "t.log")]).markdown).toContain("| a \\| b | 1 ms | 2 ms | OK |");
  });

  test("the command: prints the table and exits 1 on a miss, 0 when every budget is met, 2 on a missing log", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "db-budget-"));
    try {
      const good = path.join(dir, "good.log");
      const bad = path.join(dir, "bad.log");
      writeFileSync(good, `${P("perf_day5.sql", 263)}P6 list_lead_deals : 2.29 ms (budget 3 ms) 1 rows\n${completeLog()}\n`);
      writeFileSync(bad, `${P("perf_day5.sql", 290)}P4 move_deal win : 10.65 ms (budget 10 ms)\n`);
      const run = (...files: string[]) => spawnSync(process.execPath, [SCRIPT, ...files], { encoding: "utf8" });
      const r0 = run(good);
      expect(r0.status).toBe(0);
      expect(r0.stdout).toContain("| P6 list_lead_deals | 2.29 ms | 3 ms | OK |");
      const r1 = run(good, bad);
      expect(r1.status).toBe(1);
      expect(r1.stdout).toContain("**MISS**");
      const r2 = run(good, path.join(dir, "missing.log"));
      expect(r2.status).toBe(2);
      expect(r2.stdout).toContain("Logs missing or unreadable (1)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe("the check is complete or the run fails (exit 2)", () => {
  test("a good db-perf log with an empty stock import log: exit 2, the empty log named", () => {
    const report = render([parseLog(completeLog(), "db-perf.log"), parseLog("", "stock-import-perf.log")]);
    expect(report.code).toBe(2);
    expect(report.emptyLogs).toEqual(["stock-import-perf.log"]);
    expect(report.markdown).toContain("**Logs with no budget row (1):** `stock-import-perf.log`");
    expect(render([parseLog(completeLog(), "db-perf.log")]).code).toBe(0);
  });

  test("a line that mentions a budget but could not be read: exit 2 even when every row is OK", () => {
    const report = render([parseLog(`${completeLog()}\nX something : 3 ms, 4 ms (budget 5 ms)`, "db-perf.log")]);
    expect(report.unreadable).toHaveLength(1);
    expect(report.code).toBe(2);
  });

  test("a missed budget still exits 1 when the check is also incomplete", () => {
    expect(render([parseLog("P4 move_deal win : 10.65 ms (budget 10 ms)", "t.log")]).code).toBe(1);
  });

  test("required budget IDs: a missing or short ID exits 2 and is listed", () => {
    const withoutI13 = completeLog()
      .split("\n")
      .filter((l) => !l.startsWith("I13 "))
      .join("\n");
    const truncatedI1 = completeLog().replace("I1 case 10 : 1.00 ms (budget 5 ms)\n", "");
    const r1 = render([parseLog(withoutI13, "t.log")]);
    expect(r1.code).toBe(2);
    expect(r1.short).toEqual(["I13 (0 of 2)"]);
    expect(r1.markdown).toContain("**Required budget IDs missing or short (1):** I13 (0 of 2)");
    expect(render([parseLog(truncatedI1, "t.log")]).short).toEqual(["I1 (10 of 11)"]);
  });

  test("REQUIRED holds the IDs of the full local run; budgetId reads them from the labels", () => {
    expect(Object.keys(REQUIRED).sort()).toEqual(
      ["P1", "P2", "P3", "P4", "P4b", "P5", "P6", "P7", "P8", "P11", "I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8", "I9",
       "I10", "I11", "I12", "I13", "I14", "I16", "I17"].sort(),
    );
    expect(budgetId("P4b update_deal")).toBe("P4b");
    expect(budgetId("I13 commit_stock_import chunks of 125, all 41 calls")).toBe("I13");
    expect(budgetId("A typical lead, with a deal, undo_activity")).toBe("P5");
    expect(budgetId("A typical lead, no deal, log_activity")).toBeNull();
    expect(budgetId("list_sales page 1, all leads")).toBeNull();
  });

  test("a === header budget reaches only the next 3 lines, so it cannot leak to a later timing", () => {
    const log = [
      "=== P11 timings: milliseconds (budget 10 ms each) ===",
      "set",
      "RESET",
      "SET",
      "later case : 12.00 ms",
    ].join("\n");
    const parsed = parseLog(log, "t.log");
    expect(parsed.rows).toEqual([]);
    expect(parsed.unreadable).toEqual([expect.objectContaining({ line: 1, reason: "header budget, but no timing line after it" })]);
  });
});
