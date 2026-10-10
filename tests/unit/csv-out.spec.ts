import { expect, test } from "@playwright/test";
import { buildProblemsCsv, csvCell, problemsFileName } from "../../src/lib/import/csv-out";
import { autoMap } from "../../src/lib/import/headers";
import { parseCsvText } from "../../src/lib/import/parse";
import { cleanCell, stripFormulaGuard } from "../../src/lib/import/text";

test.describe("csvCell", () => {
  test("csv_cell_formula: = + - @ get an apostrophe", () => {
    expect(csvCell("=HYPERLINK(\"http://example.invalid\")")).toBe("\"'=HYPERLINK(\"\"http://example.invalid\"\")\"");
    expect(csvCell("+SUM(1,1)")).toBe("\"'+SUM(1,1)\"");
    expect(csvCell("-2+3")).toBe("\"'-2+3\"");
    expect(csvCell("@cmd")).toBe("\"'@cmd\"");
    expect(csvCell("+33 6 39 98 00 01")).toBe("\"'+33 6 39 98 00 01\"");
  });

  test("csv_cell_tab_cr: a leading tab or carriage return", () => {
    expect(csvCell("\t=1")).toBe("\"'\t=1\"");
    expect(csvCell("\rabc")).toBe("\"'\rabc\"");
  });

  test("csv_cell_leading_spaces: checked after leading spaces", () => {
    expect(csvCell("   =1+1")).toBe("\"'   =1+1\"");
    expect(csvCell("\u00A0@x")).toBe("\"'\u00A0@x\"");
    expect(csvCell("  plain")).toBe("\"  plain\"");
  });

  test("csv_cell_fullwidth: \uFF1D \uFF0B \uFF0D \uFF20", () => {
    for (const c of ["\uFF1D", "\uFF0B", "\uFF0D", "\uFF20"]) expect(csvCell(`${c}1`)).toBe(`"'${c}1"`);
  });

  test("csv_cell_quotes_newlines: always quoted, quotes doubled, newlines kept", () => {
    expect(csvCell("Le \"Petit\" Marché")).toBe("\"Le \"\"Petit\"\" Marché\"");
    expect(csvCell("Saint-Denis\nLa Plaine")).toBe("\"Saint-Denis\nLa Plaine\"");
    expect(csvCell("a,b;c")).toBe("\"a,b;c\"");
    expect(csvCell("")).toBe("\"\"");
    expect(csvCell(null)).toBe("\"\"");
    expect(csvCell(12)).toBe("\"12\"");
    expect(csvCell("L'Atelier")).toBe("\"L'Atelier\"");
  });
});

test.describe("stripFormulaGuard", () => {
  test("undoes csvCell's guard and nothing else", () => {
    const values = ["=1", " =1", "\u00A0@x", "\t", "\r", "\r\n", "\t=1", "\uFF1D1", "+33 6 39 98 00 01", "' text", "'", "", "plain"];
    for (const value of values) {
      const written = csvCell(value).slice(1, -1).replace(/""/g, "\"");
      expect(stripFormulaGuard(written), JSON.stringify(value)).toBe(value);
    }
    // A cell that already starts with a guard-like apostrophe reads the same whether or not it went through the file.
    for (const value of ["'=1", "'\t", "'+33 6 39 98 00 01"]) {
      const written = csvCell(value).slice(1, -1);
      expect(stripFormulaGuard(written), JSON.stringify(value)).toBe(stripFormulaGuard(value));
    }
  });
});

test.describe("problems file", () => {
  const rawHeaders = ["Company name", "Phone Number", "Email"];
  const records = [
    { row_no: 2, cells: ["=HYPERLINK(\"http://example.invalid\")", "+33 6 39 98 00 01", "nope"] },
    { row_no: 3, cells: ["Fine Ltd", "01 99 00 00 01", "ok@example.com"] },
    { row_no: 5, cells: ["Le \"Petit\" Marché", "", "a@example.com", "extra"] },
    { row_no: 9, cells: ["Short"] },
  ];
  const issues = [
    { row_no: 9, messages: ["Same name and city as row 3"] },
    { row_no: 2, messages: ["Email address doesn't look right", "Excel changed this number"] },
    { row_no: 5, messages: ["Too many columns"] },
  ];

  test("BOM, CRLF, every cell quoted, Row and Problem first, rows in order", () => {
    const csv = buildProblemsCsv({ delimiter: ";", headers: rawHeaders, records, issues, labels: { row: "Row", problem: "Problem" } });
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe("\"Row\";\"Problem\";\"Company name\";\"Phone Number\";\"Email\"");
    expect(lines[1]).toBe(
      "\"2\";\"Email address doesn't look right · Excel changed this number\";\"'=HYPERLINK(\"\"http://example.invalid\"\")\";\"'+33 6 39 98 00 01\";\"nope\"",
    );
    expect(lines[2]).toBe("\"5\";\"Too many columns\";\"Le \"\"Petit\"\" Marché\";\"\";\"a@example.com\";\"extra\"");
    expect(lines[3]).toBe("\"9\";\"Same name and city as row 3\";\"Short\";\"\";\"\"");
    expect(lines).toHaveLength(5);
  });

  test("labels follow the UI language", () => {
    const csv = buildProblemsCsv({
      delimiter: ",",
      headers: rawHeaders,
      records,
      issues: [{ row_no: 3, messages: ["a", "b"] }],
      labels: { row: "Ligne", problem: "Problème", separator: " / " },
    });
    expect(csv.split("\r\n")[0]).toBe("\uFEFF\"Ligne\",\"Problème\",\"Company name\",\"Phone Number\",\"Email\"");
    expect(csv.split("\r\n")[1]).toBe("\"3\",\"a / b\",\"Fine Ltd\",\"01 99 00 00 01\",\"ok@example.com\"");
  });

  test("round trip: the file parses back to the same values and re-imports with no remapping", async () => {
    const csv = buildProblemsCsv({ delimiter: ",", headers: rawHeaders, records, issues, labels: { row: "Row", problem: "Problem" } });
    const parsed = await parseCsvText(csv.slice(1));
    expect(parsed.headers).toEqual(["Row", "Problem", ...rawHeaders]);
    expect(autoMap(parsed.headers).targets).toEqual(["ignore", "ignore", "name", "phone", "email"]);
    for (const record of parsed.records) {
      const original = records.find((r) => String(r.row_no) === record.cells[0]);
      expect(original).toBeTruthy();
      original!.cells.forEach((cell, i) => expect(cleanCell(record.cells[i + 2])).toBe(cleanCell(cell)));
    }
  });
});

test.describe("problems file name", () => {
  test("<basename>-problems-YYYY-MM-DD.csv, without folders or unsafe characters", () => {
    expect(problemsFileName("leads.csv", "2026-10-10")).toBe("leads-problems-2026-10-10.csv");
    expect(problemsFileName("Export HubSpot 2026.10.csv", "2026-10-10T14:05:00Z")).toBe("Export HubSpot 2026.10-problems-2026-10-10.csv");
    expect(problemsFileName("C:\\Users\\h\\a<b>:c.csv", "2026-10-10")).toBe("abc-problems-2026-10-10.csv");
    expect(problemsFileName("../../etc/passwd", "2026-10-10")).toBe("passwd-problems-2026-10-10.csv");
    expect(problemsFileName(".csv", "2026-10-10")).toBe("leads-problems-2026-10-10.csv");
  });
});
