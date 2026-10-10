import { expect, test } from "@playwright/test";
import { decodeBytes } from "../../src/lib/import/decode";
import { parseCsvText } from "../../src/lib/import/parse";
import { ImportFileError, LIMITS } from "../../src/lib/import/rules";

const utf8 = (s: string) => new TextEncoder().encode(s);

async function fileError(promise: Promise<unknown>): Promise<ImportFileError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ImportFileError);
    return error as ImportFileError;
  }
  throw new Error("expected an ImportFileError");
}

test.describe("parse", () => {
  test("detects ; even in a short file with a trailing newline", async () => {
    const parsed = await parseCsvText("Société;Ville\nCafé du Port;Lyon\n");
    expect(parsed.delimiter).toBe(";");
    expect(parsed.headers).toEqual(["Société", "Ville"]);
    expect(parsed.records).toEqual([{ row_no: 2, cells: ["Café du Port", "Lyon"] }]);
  });

  test("detects tab and pipe; a one-column file falls back to comma", async () => {
    expect((await parseCsvText("a\tb\n1\t2\n")).delimiter).toBe("\t");
    expect((await parseCsvText("a|b\n1|2\n")).delimiter).toBe("|");
    const single = await parseCsvText("Company name\nMaison Verdane\nAtelier Azur\n");
    expect(single.delimiter).toBe(",");
    expect(single.records.map((r) => r.cells)).toEqual([["Maison Verdane"], ["Atelier Azur"]]);
  });

  test("Excel row numbers: header = 1, multi-line cells are one row, blank rows keep their number", async () => {
    const text = [
      "Company name,City",
      "\"Dupont, Fils & Cie\",\"Saint-Denis",
      "La Plaine\"",
      "",
      ",",
      "Le \"\"Petit\"\" Marché,Lyon",
      "\"Le \"\"Petit\"\" Marché\",Nantes",
      "  ,  ",
      "Atelier Azur,Paris",
      "",
      "",
    ].join("\r\n");
    const parsed = await parseCsvText(text);
    expect(parsed.records.map((r) => r.row_no)).toEqual([2, 5, 6, 8]);
    expect(parsed.records[0].cells).toEqual(["Dupont, Fils & Cie", "Saint-Denis\r\nLa Plaine"]);
    expect(parsed.records[2].cells).toEqual(["Le \"Petit\" Marché", "Nantes"]);
    expect(parsed.blankRows).toBe(3); // rows 3, 4 and 7; the trailing empty lines are not counted
    expect(parsed.rowCount).toBe(4);
    expect(parsed.lastRowNo).toBe(8);
  });

  test("extra and missing cells are kept as written", async () => {
    const parsed = await parseCsvText("a,b,c\n1,2,3,4,5\n1\n");
    expect(parsed.records.map((r) => r.cells)).toEqual([["1", "2", "3", "4", "5"], ["1"]]);
  });

  test("trailing empty header cells (Excel padding) are dropped; duplicates are numbered", async () => {
    const parsed = await parseCsvText("Email,Company,email,,\nx,y,z,,\n");
    expect(parsed.headers).toEqual(["Email", "Company", "email (2)"]);
    expect(parsed.rawHeaders).toEqual(["Email", "Company", "email"]);
  });

  test("sep=; first line and BOM (through decodeBytes)", async () => {
    const decoded = decodeBytes(utf8("\uFEFFsep=;\r\nName,with comma;City\r\nA,B;Lyon\r\n"));
    expect(decoded.sepHint).toBe(";");
    const parsed = await parseCsvText(decoded.text, { sepHint: decoded.sepHint });
    expect(parsed.delimiter).toBe(";");
    expect(parsed.headers).toEqual(["Name,with comma", "City"]);
    expect(parsed.records).toEqual([{ row_no: 2, cells: ["A,B", "Lyon"] }]);
  });

  test("a __proto__ header cannot pollute objects", async () => {
    const parsed = await parseCsvText("__proto__,constructor,polluted\n{\"x\":1},y,yes\n");
    expect(parsed.headers).toEqual(["__proto__", "constructor", "polluted"]);
    expect(Array.isArray(parsed.records[0].cells)).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(parsed.records[0])).toBe(Object.prototype);
  });

  test("quote errors stop the read with the row number", async () => {
    const missing = await fileError(parseCsvText("a,b\n1,2\n3,4\n5,\"open\n6,7\n"));
    expect(missing.code).toBe("quote_error");
    expect(missing.rowNo).toBe(4);
    const invalid = await fileError(parseCsvText("a,b\n1,2\n\"3\"x,4\n5,6\n"));
    expect(invalid.code).toBe("quote_error");
    expect(invalid.rowNo).toBe(3);
  });

  test("quote errors keep the right row number across slices", async () => {
    const rows = Array.from({ length: 300 }, (_, i) => `r${i},"multi\nline ${i}"`);
    const text = `h1,h2\n${rows.join("\n")}\nbad,"never closed\nmore,stuff\n`;
    const error = await fileError(parseCsvText(text, { chunkSize: 64 }));
    expect(error.rowNo).toBe(302);
  });

  test("accented text and emoji across tiny slices: no U+FFFD, identical result", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => `Société Générale d'Électricité ${i} 😀,Liège,"Zürich, Ñandú ${i}"`);
    const bytes = utf8(`Company,City,Note\n${rows.join("\n")}\n`);
    const { text } = decodeBytes(bytes);
    const whole = await parseCsvText(text);
    const sliced = await parseCsvText(text, { chunkSize: 7 });
    expect(sliced.records).toEqual(whole.records);
    expect(sliced.records).toHaveLength(200);
    expect(JSON.stringify(sliced.records)).not.toContain("�");
    expect(sliced.records[199].cells[0]).toBe("Société Générale d'Électricité 199 😀");
  });

  test("yields between slices through the scheduler and reports progress", async () => {
    let yields = 0;
    let last = { done: 0, total: 0, rows: 0 };
    const text = `a,b\n${Array.from({ length: 500 }, (_, i) => `${i},x`).join("\n")}\n`;
    const parsed = await parseCsvText(text, {
      chunkSize: 256,
      schedule: (resume) => {
        yields++;
        setTimeout(resume, 0);
      },
      onProgress: (p) => (last = p),
    });
    expect(parsed.rowCount).toBe(500);
    expect(yields).toBeGreaterThan(10);
    expect(last.done).toBe(text.length);
    expect(last.rows).toBe(500);
  });

  test("an abort signal stops the read", async () => {
    const controller = new AbortController();
    const text = `a,b\n${Array.from({ length: 2000 }, (_, i) => `${i},x`).join("\n")}\n`;
    const promise = parseCsvText(text, {
      chunkSize: 100,
      signal: controller.signal,
      schedule: (resume) => {
        controller.abort();
        setTimeout(resume, 0);
      },
    });
    expect((await fileError(promise)).code).toBe("aborted");
  });

  test("limits: columns, header length, rows", async () => {
    const wide = Array.from({ length: LIMITS.maxColumns + 1 }, (_, i) => `c${i}`).join(",");
    expect((await fileError(parseCsvText(`${wide}\n1\n`))).code).toBe("too_many_columns");
    const atLimit = Array.from({ length: LIMITS.maxColumns }, (_, i) => `c${i}`).join(",");
    expect((await parseCsvText(`${atLimit}\n1\n`)).headers).toHaveLength(LIMITS.maxColumns);

    expect((await fileError(parseCsvText(`${"h".repeat(201)},b\n1,2\n`))).code).toBe("header_too_long");
    expect((await parseCsvText(`${"h".repeat(200)},b\n1,2\n`)).headers[0]).toHaveLength(200);

    const body = (n: number) => Array.from({ length: n }, (_, i) => `${i}`).join("\n");
    const ok = await parseCsvText(`n\n${body(LIMITS.maxDataRows)}\n\n\n`);
    expect(ok.lastRowNo).toBe(LIMITS.maxRowNo);
    const tooMany = await fileError(parseCsvText(`n\n${body(LIMITS.maxDataRows + 1)}\n`));
    expect(tooMany.code).toBe("too_many_rows");
    expect(tooMany.rowNo).toBe(LIMITS.maxRowNo + 1);
    // Blank rows inside the data count towards the limit.
    const blanks = await fileError(parseCsvText(`n\n\n${body(LIMITS.maxDataRows)}\n`));
    expect(blanks.code).toBe("too_many_rows");
  });

  test("no header row, or no data rows", async () => {
    expect((await fileError(parseCsvText("\nName\nA\n"))).code).toBe("no_header");
    expect((await fileError(parseCsvText(",,\nA,B,C\n"))).code).toBe("no_header");
    expect((await fileError(parseCsvText("Name,City\n\n\n"))).code).toBe("no_rows");
  });
});
