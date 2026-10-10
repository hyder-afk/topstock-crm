import { expect, test } from "@playwright/test";
import { autoMap } from "../../src/lib/import/headers";
import {
  createNormaliser,
  normaliseCity,
  normaliseDate,
  normaliseEmail,
  normaliseInSlices,
  normaliseName,
  normalisePhone,
  normaliseRecords,
  supportedTimeZones,
  tally,
  toLocalDateTime,
  type DateContext,
  type NormaliseOptions,
} from "../../src/lib/import/normalise";
import { ImportFileError, ImportRulesError } from "../../src/lib/import/rules";
import { importRowSchema } from "../../src/lib/import/schema";
import { cleanCell, cleanText, codePointLength } from "../../src/lib/import/text";

const NOW = new Date("2026-10-10T12:00:00Z"); // 14:00 in Paris (summer time)
const paris = (order: "dmy" | "mdy" = "dmy"): DateContext => ({
  order,
  timeZone: "Europe/Paris",
  nowLocal: toLocalDateTime(NOW.getTime(), "Europe/Paris"),
});

test.describe("cell cleaning", () => {
  test("spaces: NBSP, narrow NBSP, tabs and newlines become one space; trimmed", () => {
    expect(cleanText("  Maison\u00A0\u00A0Orion\u202Fet\tFils \r\n Lyon\n")).toBe("Maison Orion et Fils Lyon");
    expect(cleanText("a\u2028b\u2029c\u0085d")).toBe("a b c d");
  });

  test("bidi and control characters are stripped", () => {
    expect(cleanText("\u202EBazar\u202C Lumière")).toBe("Bazar Lumière");
    expect(cleanText("Comptoir\u0007 Belle\u0000 Rive\u007F\u0081")).toBe("Comptoir Belle Rive");
    expect(cleanText("\u2066Isolé\u2069")).toBe("Isolé");
  });

  test("zero-width characters and the BOM are removed", () => {
    expect(cleanText("\uFEFFAtelier\u200BAzur\u200D\u2060")).toBe("AtelierAzur");
    expect(cleanText("\u200B")).toBe("");
  });

  test("NFC", () => {
    const decomposed = "Café";
    expect(cleanText(decomposed)).toBe("Café");
    expect(cleanText(decomposed).length).toBe(4);
  });

  test("one leading apostrophe is removed before = + - @ (a fixed problems file round-trips)", () => {
    expect(cleanText("'=SUM(A1:A2)")).toBe("=SUM(A1:A2)");
    expect(cleanText("'+33 6 39 98 00 01")).toBe("+33 6 39 98 00 01");
    expect(cleanText("'-2+3")).toBe("-2+3");
    expect(cleanText("'@cmd")).toBe("@cmd");
    expect(cleanText("'  =1")).toBe("=1");
    expect(cleanText("'\uFF1D1")).toBe("\uFF1D1");
    expect(cleanText("'abc")).toBe("'abc");
    expect(cleanText("L'Atelier")).toBe("L'Atelier");
    // Only one guard is removed, and only when a formula character follows it.
    expect(cleanText("''=1")).toBe("''=1");
  });

  test("the guard is removed from the cell as written, before cleaning: blank cells stay blank", () => {
    // csvCell guards a cell that starts with a tab or a carriage return; once removed, the cell is blank again.
    expect(cleanText("'\t")).toBe("");
    expect(cleanText("'\r")).toBe("");
    expect(cleanText("'\r\n")).toBe("");
    expect(cleanText("'\t=1")).toBe("=1");
    expect(cleanText("'\r\n'-")).toBe("'-");
    expect(cleanText("' =1")).toBe("=1");
    // An apostrophe that is not a guard stays, even before a space or after leading spaces.
    expect(cleanText("' text")).toBe("' text");
    expect(cleanText(" '=1")).toBe("'=1");
    expect(cleanText("'")).toBe("'");
    expect(cleanText("'   ")).toBe("'");
  });

  test("placeholders become empty", () => {
    for (const p of ["n/a", "N/A", "na", "None", "NULL", "-", "--", "/", "?", "aucun", "Néant", "inconnu", "Unknown", "TBD", "#N/A"]) {
      expect(cleanCell(p), p).toBe("");
      expect(cleanCell(` ${p} `), p).toBe("");
    }
    expect(cleanCell("nan")).toBe("nan");
    expect(cleanCell("Nantes")).toBe("Nantes");
    expect(cleanText("n/a")).toBe("n/a");
  });

  test("code points, not UTF-16 units", () => {
    expect(codePointLength("😀😀")).toBe(2);
    expect(codePointLength("東京")).toBe(2);
    expect(codePointLength("é")).toBe(2);
  });
});

test.describe("name", () => {
  test("missing and too long", () => {
    expect(normaliseName(" ")).toEqual({ value: "", problem: "name_missing" });
    expect(normaliseName("\u00A0\u200B")).toEqual({ value: "", problem: "name_missing" });
    expect(normaliseName("n/a").problem).toBe("name_missing");
    expect(normaliseName("x".repeat(200))).toEqual({ value: "x".repeat(200), problem: null });
    expect(normaliseName("x".repeat(201)).problem).toBe("name_too_long");
    // 200 emoji are 400 UTF-16 units but 200 characters for Postgres.
    expect(normaliseName("😀".repeat(200)).problem).toBeNull();
    expect(normaliseName("😀".repeat(201)).problem).toBe("name_too_long");
  });

  test("injection and markup are kept as text", () => {
    expect(normaliseName("'); drop table companies; --").value).toBe("'); drop table companies; --");
    expect(normaliseName("<img src=x onerror=alert(1)>").value).toBe("<img src=x onerror=alert(1)>");
    expect(normaliseName("),id.eq.").value).toBe("),id.eq.");
  });
});

test.describe("email", () => {
  test("mailto: removed and lower case", () => {
    expect(normaliseEmail(" Contact@Example.COM ")).toEqual({ value: "contact@example.com", problem: null });
    expect(normaliseEmail("mailto:Sales@Example.org")).toEqual({ value: "sales@example.org", problem: null });
    expect(normaliseEmail("MAILTO: a@b.example.net?subject=Hi").value).toBe("a@b.example.net");
    expect(normaliseEmail("")).toEqual({ value: null, problem: null });
    expect(normaliseEmail("n/a")).toEqual({ value: null, problem: null });
  });

  test("not one plain address", () => {
    const bad = [
      "contact@example",
      "ventes.example.com",
      "contact@@example.com",
      "@example.com",
      "info@example..com",
      "jean dupont@example.com",
      "a@b@example.org",
      "contact@example.com, ventes@example.com",
      "contact@example.com;achats@example.net",
      "contact@.example.org",
      "contact@",
      "mailto:",
      `${"a".repeat(250)}@example.com`,
    ];
    for (const raw of bad) expect(normaliseEmail(raw), raw).toEqual({ value: null, problem: "email_invalid" });
  });
});

test.describe("phone", () => {
  test("kept as written, dashes and tel: tidied", () => {
    expect(normalisePhone("+33 6 39 98 00 01").value).toBe("+33 6 39 98 00 01");
    expect(normalisePhone("06.39.98.00.01").value).toBe("06.39.98.00.01");
    expect(normalisePhone("+33 (0)6 39 98 00 01").value).toBe("+33 (0)6 39 98 00 01");
    expect(normalisePhone("tel:+33639980001").value).toBe("+33639980001");
    expect(normalisePhone("06–39–98–00–01").value).toBe("06-39-98-00-01");
    expect(normalisePhone("020\u00A07946\u00A00123").value).toBe("020 7946 0123");
    expect(normalisePhone("123456").value).toBe("123456");
    expect(normalisePhone("-")).toEqual({ value: null, problem: null });
  });

  test("Excel's scientific notation is phone_mangled", () => {
    for (const raw of ["3.36E+11", "6.12345678E+8", "3,36E+11", "3.36e11"]) {
      expect(normalisePhone(raw), raw).toEqual({ value: null, problem: "phone_mangled" });
    }
  });

  test("letters, other characters or fewer than 6 digits are phone_invalid", () => {
    for (const raw of ["ext 12", "06 39 98 AB CD", "12345", "+33 6 39 98 12 34 poste 5", "06 39 98 12 34 #2", "\uFF10\uFF16"]) {
      expect(normalisePhone(raw), raw).toEqual({ value: null, problem: "phone_invalid" });
    }
  });

  test("more than 40 characters is phone_too_long", () => {
    const forty = "+33 1 99 00 12 34 / +33 6 39 98 12 34 / ";
    expect(forty.length).toBe(40);
    expect(normalisePhone(`${forty.trimEnd()}1`).problem).toBeNull();
    expect(normalisePhone(`${forty}1`)).toEqual({ value: null, problem: "phone_too_long" });
  });
});

test.describe("city", () => {
  test("more than 120 characters", () => {
    expect(normaliseCity("Saint-Denis\nLa Plaine").value).toBe("Saint-Denis La Plaine");
    expect(normaliseCity("x".repeat(120)).problem).toBeNull();
    expect(normaliseCity("x".repeat(121))).toEqual({ value: null, problem: "city_too_long" });
    expect(normaliseCity("")).toEqual({ value: null, problem: null });
  });
});

test.describe("last activity dates", () => {
  const ok = (raw: string, ctx = paris()) => normaliseDate(raw, ctx).value;
  const problem = (raw: string, ctx = paris()) => normaliseDate(raw, ctx).problem;

  test("day-first formats, optional time, 2-digit years", () => {
    expect(ok("15/03/2025")).toBe("2025-03-15T00:00:00");
    expect(ok("15/03/2025 14:32")).toBe("2025-03-15T14:32:00");
    expect(ok("15/03/2025 14:32:05")).toBe("2025-03-15T14:32:05");
    expect(ok("15.03.2025")).toBe("2025-03-15T00:00:00");
    expect(ok("15-03-25")).toBe("2025-03-15T00:00:00");
    expect(ok("5/3/2025 9:05")).toBe("2025-03-05T09:05:00");
    expect(ok("03/04/2025")).toBe("2025-04-03T00:00:00");
  });

  test("month-first order, AM/PM only there", () => {
    expect(ok("03/04/2025", paris("mdy"))).toBe("2025-03-04T00:00:00");
    expect(ok("03/15/2025 2:30 PM", paris("mdy"))).toBe("2025-03-15T14:30:00");
    expect(ok("12/01/2025 12:00 AM", paris("mdy"))).toBe("2025-12-01T00:00:00");
    expect(ok("12/01/2025 12:15 p.m.", paris("mdy"))).toBe("2025-12-01T12:15:00");
    expect(problem("15/03/2025 2:30 PM")).toBe("date_invalid");
    expect(problem("03/15/2025 13:30 PM", paris("mdy"))).toBe("date_invalid");
    // A conflicting cell in a mixed file: invalid in the chosen order.
    expect(problem("03/15/2025")).toBe("date_invalid");
  });

  test("ISO dates, with a time and an offset converted into the source time zone", () => {
    expect(ok("2025-03-15")).toBe("2025-03-15T00:00:00");
    expect(ok("2025-03-15 14:32")).toBe("2025-03-15T14:32:00");
    expect(ok("2025-03-15T14:32:07")).toBe("2025-03-15T14:32:07");
    expect(ok("2025-03-15T13:32:00Z")).toBe("2025-03-15T14:32:00");
    expect(ok("2025-03-15T13:32:00.000Z")).toBe("2025-03-15T14:32:00");
    expect(ok("2025-07-15T14:32:00+02:00")).toBe("2025-07-15T14:32:00");
    expect(ok("2025-07-15T09:32:00-0300")).toBe("2025-07-15T14:32:00");
    expect(ok("2025/03/15")).toBe("2025-03-15T00:00:00");
    const ny: DateContext = { ...paris(), timeZone: "America/New_York" };
    expect(ok("2025-03-15T14:32:00Z", ny)).toBe("2025-03-15T10:32:00");
  });

  test("Excel serial numbers 20000 to 80000", () => {
    expect(ok("45731")).toBe("2025-03-15T00:00:00");
    expect(ok("45731.5")).toBe("2025-03-15T12:00:00");
    expect(ok("45731,75")).toBe("2025-03-15T18:00:00");
    expect(problem("19999")).toBe("date_invalid");
    expect(problem("80001")).toBe("date_invalid");
  });

  test("calendar validity and leap years", () => {
    expect(problem("31/02/2024")).toBe("date_invalid");
    expect(ok("29/02/2024")).toBe("2024-02-29T00:00:00");
    expect(problem("29/02/2023")).toBe("date_invalid");
    expect(ok("29/02/2000")).toBe("2000-02-29T00:00:00");
    expect(problem("32/01/2023")).toBe("date_invalid");
    expect(problem("00/00/0000")).toBe("date_invalid");
    expect(problem("12/2023")).toBe("date_invalid");
    expect(problem("2024-13-01")).toBe("date_invalid");
    expect(problem("15/03/2025 24:00")).toBe("date_invalid");
    expect(problem("15/03/2025 12:60")).toBe("date_invalid");
    expect(problem("yesterday")).toBe("date_invalid");
    expect(problem("2025-03-15T10:00:00+15:00")).toBe("date_invalid");
  });

  test("future and before 1990", () => {
    expect(problem("15/06/2031")).toBe("date_future");
    expect(problem("2030-01-01")).toBe("date_future");
    expect(problem("11/10/2026")).toBe("date_future");
    expect(ok("10/10/2026 13:59")).toBe("2026-10-10T13:59:00");
    expect(problem("10/10/2026 14:00:01")).toBe("date_future");
    expect(problem("15/06/1985")).toBe("date_too_old");
    expect(problem("01/01/1970")).toBe("date_too_old");
    expect(problem("31/12/1989 23:59")).toBe("date_too_old");
    expect(problem("1950-01-01T00:00:00Z")).toBe("date_too_old");
    expect(ok("01/01/1990")).toBe("1990-01-01T00:00:00");
  });

  test("DST: a spring-gap time is kept for SQL to move forward; offsets give real local times", () => {
    expect(ok("30/03/2025 02:30")).toBe("2025-03-30T02:30:00");
    expect(ok("29/03/2026 02:15")).toBe("2026-03-29T02:15:00");
    expect(ok("2025-03-30T01:30:00Z")).toBe("2025-03-30T03:30:00");
    expect(ok("2025-10-26T00:30:00Z")).toBe("2025-10-26T02:30:00");
    expect(ok("2025-10-26T01:30:00Z")).toBe("2025-10-26T02:30:00");
  });

  test("blank is no date", () => {
    expect(normaliseDate("", paris())).toEqual({ value: null, problem: null });
    expect(normaliseDate("n/a", paris())).toEqual({ value: null, problem: null });
  });
});

test.describe("rows", () => {
  const HEADER = ["Company name", "Company owner", "Phone Number", "Email", "Lead Status", "Last Activity Date", "City", "Country/Region"];
  const team = [
    { id: "11111111-1111-4111-8111-111111111111", first_name: "Haider", last_name: "Test" },
    { id: "22222222-2222-4222-8222-222222222222", first_name: "Henri", last_name: "Test" },
  ];
  const base: NormaliseOptions = {
    mapping: autoMap(HEADER).targets,
    team,
    dateOrder: "dmy",
    timeZone: "Europe/Paris",
    now: NOW,
  };
  const row = (cells: string[], row_no = 2) => ({ row_no, cells });
  const good = ["Maison Verdane", "Haider Test", "+33 6 39 98 00 01", "Contact@Example.com", "Warm (in progress)", "15/03/2025 14:32", "Lyon", "France"];

  test("a clean row becomes the staged payload", () => {
    const [r] = normaliseRecords([row(good)], base);
    expect(r.rejected).toBe(false);
    expect(r.payload).toEqual({
      row_no: 2,
      name: "Maison Verdane",
      owner_id: team[0].id,
      lead_status: "warm",
      phone: "+33 6 39 98 00 01",
      email: "contact@example.com",
      city: "Lyon",
      country: "FR",
      last_activity: "2025-03-15T14:32:00",
      fixes: [],
    });
    expect(importRowSchema.safeParse(r.payload).success).toBe(true);
  });

  test("a rejected row sends only its number and problem codes", () => {
    const [r] = normaliseRecords([row(["\u00A0", ...good.slice(1)], 7)], base);
    expect(r.rejected).toBe(true);
    expect(r.payload).toEqual({ row_no: 7, problems: ["name_missing"] });
    expect(Object.keys(r.payload)).toEqual(["row_no", "problems"]);
    // The screen still gets the canonical values, in memory.
    expect(r.display.email).toBe("contact@example.com");
  });

  test("extra cells: empty ones are fine, filled ones are columns_extra", () => {
    expect(normaliseRecords([row([...good, "", " "])], base)[0].rejected).toBe(false);
    expect(normaliseRecords([row([...good, "", "oops"])], base)[0].problems).toEqual(["columns_extra"]);
  });

  test("missing trailing cells count as empty", () => {
    const [r] = normaliseRecords([row(["Atelier Azur"])], base);
    expect(r.payload).toEqual({
      row_no: 2,
      name: "Atelier Azur",
      owner_id: null,
      lead_status: "cold",
      phone: null,
      email: null,
      city: null,
      country: null,
      last_activity: null,
      fixes: [],
    });
  });

  test("cell_too_long applies to imported columns only", () => {
    const longName = normaliseRecords([row(["x".repeat(2001), ...good.slice(1)])], base)[0];
    expect(longName.problems).toEqual(["name_too_long", "cell_too_long"]);
    const options = { ...base, mapping: [...base.mapping, "ignore" as const] };
    expect(normaliseRecords([row([...good, "n".repeat(3000)])], options)[0].rejected).toBe(false);
  });

  test("reject_row: a bad email, phone, date or city rejects the row with every problem", () => {
    const cells = [...good];
    cells[2] = "3.36E+11";
    cells[3] = "contact@example";
    cells[5] = "31/02/2024";
    cells[6] = "c".repeat(121);
    const [r] = normaliseRecords([row(cells)], base);
    expect(r.payload).toEqual({
      row_no: 2,
      problems: ["email_invalid", "phone_mangled", "date_invalid", "city_too_long"],
    });
  });

  test("blank_field: the bad fields are left empty with a fix code each", () => {
    const cells = [...good];
    cells[2] = "ext 12";
    cells[3] = "a@@b.com";
    cells[5] = "15/06/2031";
    cells[6] = "c".repeat(121);
    const [r] = normaliseRecords([row(cells)], { ...base, badFieldPolicy: "blank_field" });
    expect(r.rejected).toBe(false);
    expect(r.payload).toMatchObject({ phone: null, email: null, last_activity: null, city: null });
    expect(r.fixes).toEqual(["email_dropped", "phone_dropped", "date_dropped", "city_dropped"]);
    expect(importRowSchema.safeParse(r.payload).success).toBe(true);
  });

  test("blank_field: row problems still reject, listing the field problems too", () => {
    const cells = ["", ...good.slice(1)];
    cells[3] = "nope";
    const [r] = normaliseRecords([row(cells)], { ...base, badFieldPolicy: "blank_field" });
    expect(r.payload).toEqual({ row_no: 2, problems: ["name_missing", "email_invalid"] });
  });

  test("owners: unknown -> unassigned with a fix; an explicit choice wins", () => {
    const unknown = [...good];
    unknown[1] = "Former Rep";
    expect(normaliseRecords([row(unknown)], base)[0].payload).toMatchObject({ owner_id: null, fixes: ["owner_unassigned"] });
    const chosen = normaliseRecords([row(unknown)], { ...base, ownerChoices: new Map([["former rep", team[1].id]]) })[0];
    expect(chosen.payload).toMatchObject({ owner_id: team[1].id, fixes: [] });
    const blank = [...good];
    blank[1] = "";
    expect(normaliseRecords([row(blank)], base)[0].payload).toMatchObject({ owner_id: null, fixes: [] });
  });

  test("countries: unknown -> blank with a fix; an explicit choice wins; codes only", () => {
    const cells = [...good];
    cells[7] = "Atlantis";
    expect(normaliseRecords([row(cells)], base)[0].payload).toMatchObject({ country: null, fixes: ["country_dropped"] });
    const picked = normaliseRecords([row(cells)], { ...base, countryChoices: new Map([["atlantis", "GR"]]) })[0];
    expect(picked.payload).toMatchObject({ country: "GR", fixes: [] });
    const notACode = normaliseRecords([row(cells)], { ...base, countryChoices: new Map([["atlantis", "XX"]]) })[0];
    expect(notACode.payload).toMatchObject({ country: null, fixes: ["country_dropped"] });
  });

  test("statuses: blank uses the default, unknown words need a choice", () => {
    const blank = [...good];
    blank[4] = "";
    expect(normaliseRecords([row(blank)], base)[0].payload).toMatchObject({ lead_status: "cold" });
    expect(normaliseRecords([row(blank)], { ...base, defaultStatus: "warm" })[0].payload).toMatchObject({ lead_status: "warm" });
    const hot = [...good];
    hot[4] = "Hot lead";
    expect(() => normaliseRecords([row(hot)], base)).toThrow(ImportRulesError);
    const chosen = normaliseRecords([row(hot)], { ...base, statusChoices: new Map([["hot lead", "warm" as const]]) })[0];
    expect(chosen.payload).toMatchObject({ lead_status: "warm" });
    // An explicit choice also overrides a suggestion.
    const override = normaliseRecords([row(good)], { ...base, statusChoices: new Map([["warm in progress", "negotiation" as const]]) });
    expect(override[0].payload).toMatchObject({ lead_status: "negotiation" });
  });

  test("the time zone list contains the default", () => {
    expect(supportedTimeZones()).toContain("Europe/Paris");
  });

  test("preconditions: a name column and a real time zone", () => {
    expect(() => createNormaliser({ ...base, mapping: ["ignore", "owner"] })).toThrow(ImportRulesError);
    expect(() => createNormaliser({ ...base, timeZone: "Mars/Olympus" })).toThrow(ImportRulesError);
  });

  test("hidden characters never reach the payload", () => {
    const [r] = normaliseRecords([row(["\u202EBazar\u0007 Lumière\u200B", ...good.slice(1)])], base);
    expect(r.payload).toMatchObject({ name: "Bazar Lumière" });
    expect(importRowSchema.safeParse(r.payload).success).toBe(true);
  });

  test("normaliseInSlices gives the same rows, yielding between slices, and can be stopped", async () => {
    const records = Array.from({ length: 2500 }, (_, i) => row(i % 7 ? good : ["", ...good.slice(1)], i + 2));
    let yields = 0;
    let progress = 0;
    const sliced = await normaliseInSlices(records, base, {
      sliceSize: 400,
      schedule: (resume) => {
        yields++;
        setTimeout(resume, 0);
      },
      onProgress: (done) => (progress = done),
    });
    expect(sliced).toEqual(normaliseRecords(records, base));
    expect(yields).toBe(6);
    expect(progress).toBe(2500);
    const controller = new AbortController();
    const stopped = normaliseInSlices(records, base, {
      sliceSize: 100,
      signal: controller.signal,
      schedule: (resume) => {
        controller.abort();
        setTimeout(resume, 0);
      },
    });
    await expect(stopped).rejects.toBeInstanceOf(ImportFileError);
  });

  test("tally counts staged, rejected, problems and fixes", () => {
    const unknown = [...good];
    unknown[1] = "Former Rep";
    const rows = normaliseRecords([row(good, 2), row(["", ...good.slice(1)], 3), row(unknown, 4)], base);
    const t = tally(rows);
    expect([t.staged, t.rejected, t.withFixes]).toEqual([2, 1, 1]);
    expect(t.problems.get("name_missing")).toBe(1);
    expect(t.fixes.get("owner_unassigned")).toBe(1);
  });
});
