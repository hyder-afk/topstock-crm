import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { countryCodes } from "../../src/lib/countries";
import { leadStatuses } from "../../src/lib/leads";
import { STATUS_ALIASES } from "../../src/lib/import/rules";
import {
  COUNTRY_ALIASES,
  createOwnerMatcher,
  detectDateOrder,
  distinctValues,
  matchCountry,
  matchOwner,
  statusKey,
  suggestDateOrder,
  suggestStatus,
} from "../../src/lib/import/values";

const messages = (locale: string) =>
  JSON.parse(readFileSync(path.join(__dirname, "..", "..", "messages", `${locale}.json`), "utf8")) as {
    Leads: { status: Record<string, string> };
  };

test.describe("status suggestions", () => {
  test("every alias suggests its status", () => {
    for (const [alias, status] of STATUS_ALIASES) expect(suggestStatus(alias), alias).toBe(status);
  });

  test("Haider's spelling, case and space variants, HubSpot values and FR words", () => {
    const cases: Array<[string, string]> = [
      ["Cold", "cold"],
      ["  COLD ", "cold"],
      ["Warm (in progress)", "warm"],
      ["Warm (in Progress)", "warm"],
      ["in progress", "warm"],
      ["IN_PROGRESS", "warm"],
      ["Negotiation", "negotiation"],
      ["Customer", "customer"],
      ["client", "customer"],
      ["Cool off", "cool_off"],
      ["Cool-off", "cool_off"],
      ["cool_off", "cool_off"],
      ["Do not contact", "do_not_contact"],
      ["DO_NOT_CONTACT", "do_not_contact"],
      ["ne pas contacter", "do_not_contact"],
      ["dnc", "do_not_contact"],
      ["Disqualified", "disqualified"],
      ["unqualified", "disqualified"],
      ["UNQUALIFIED", "disqualified"],
      ["non qualifié", "disqualified"],
      ["Non-Qualifié", "disqualified"],
    ];
    for (const [raw, status] of cases) expect(suggestStatus(raw), raw).toBe(status);
  });

  test("the EN and FR labels the app shows map back to their status", () => {
    for (const locale of ["en", "fr"]) {
      const labels = messages(locale).Leads.status;
      for (const status of leadStatuses) expect(suggestStatus(labels[status]), `${locale} ${status}`).toBe(status);
    }
  });

  test("unknown words need a choice; blank has no suggestion", () => {
    for (const raw of ["Hot lead", "Prospect", "Lead", "Warmish", "12"]) expect(suggestStatus(raw), raw).toBeNull();
    expect(suggestStatus("")).toBeNull();
    expect(suggestStatus("n/a")).toBeNull();
    expect(statusKey("  ")).toBe("");
  });

  test("one key per spelling family", () => {
    expect(statusKey("Cool-off")).toBe(statusKey("COOL OFF"));
    expect(statusKey("Warm (in Progress)")).toBe(statusKey("warm in progress"));
    expect(statusKey("Hot lead")).toBe("hot lead");
  });
});

test.describe("owner matching", () => {
  const team = [
    { id: "11111111-1111-4111-8111-111111111111", first_name: "Haider", last_name: "Test" },
    { id: "22222222-2222-4222-8222-222222222222", first_name: "Henri", last_name: "Test" },
    { id: "33333333-3333-4333-8333-333333333333", first_name: "Kais", last_name: "Test" },
    { id: "44444444-4444-4444-8444-444444444444", first_name: "Jean", last_name: "Dupont" },
    { id: "55555555-5555-4555-8555-555555555555", first_name: "Jean", last_name: "Martin" },
    { id: "66666666-6666-4666-8666-666666666666", first_name: "Zoé", last_name: "Lefèvre" },
  ];

  test("full name, without accents or case", () => {
    expect(matchOwner("Haider Test", team)).toBe(team[0].id);
    expect(matchOwner("kais test", team)).toBe(team[2].id);
    expect(matchOwner("  HENRI   TEST ", team)).toBe(team[1].id);
    expect(matchOwner("Zoe Lefevre", team)).toBe(team[5].id);
    expect(matchOwner("ZOÉ LEFÈVRE", team)).toBe(team[5].id);
  });

  test('"last first"', () => {
    expect(matchOwner("Test Haider", team)).toBe(team[0].id);
    expect(matchOwner("Dupont Jean", team)).toBe(team[3].id);
  });

  test("a first name only one user has", () => {
    expect(matchOwner("Kais", team)).toBe(team[2].id);
    expect(matchOwner("zoe", team)).toBe(team[5].id);
  });

  test("ambiguous or unknown names come in unassigned", () => {
    expect(matchOwner("Jean", team)).toBeNull();
    expect(matchOwner("Test", team)).toBeNull();
    expect(matchOwner("Former Rep", team)).toBeNull();
    expect(matchOwner("", team)).toBeNull();
    const twins = [...team, { id: "77777777-7777-4777-8777-777777777777", first_name: "Haider", last_name: "Test" }];
    expect(matchOwner("Haider Test", twins)).toBeNull();
  });

  test("users without a name yet never match", () => {
    const match = createOwnerMatcher([{ id: team[0].id, first_name: null, last_name: "" }]);
    expect(match("x")).toBeNull();
    expect(match("")).toBeNull();
  });
});

test.describe("country matching", () => {
  test("ISO codes in any case", () => {
    expect(matchCountry("FR")).toBe("FR");
    expect(matchCountry("fr")).toBe("FR");
    expect(matchCountry(" gb ")).toBe("GB");
    // "NA" is the "n/a" placeholder before it is Namibia's code; "Namibia" and "Namibie" still match.
    for (const code of countryCodes) expect(matchCountry(code), code).toBe(code === "NA" ? null : code);
    expect(matchCountry("Namibie")).toBe("NA");
  });

  test("English and French names from Intl for every code", () => {
    let roundTrips = 0;
    for (const locale of ["en", "fr"]) {
      const names = new Intl.DisplayNames([locale], { type: "region" });
      for (const code of countryCodes) if (matchCountry(names.of(code)) === code) roundTrips++;
    }
    // Every name maps back to its own code (no two codes share an English or French name).
    expect(roundTrips).toBe(countryCodes.length * 2);
    expect(matchCountry("France")).toBe("FR");
    expect(matchCountry("Royaume-Uni")).toBe("GB");
    expect(matchCountry("Allemagne")).toBe("DE");
    expect(matchCountry("Belgique")).toBe("BE");
    expect(matchCountry("Maroc")).toBe("MA");
    expect(matchCountry("Côte d'Ivoire")).toBe("CI");
    expect(matchCountry("COTE D IVOIRE")).toBe("CI");
    expect(matchCountry("United Kingdom")).toBe("GB");
  });

  test("aliases from the design", () => {
    const expected: Array<[string, string]> = [
      ["UK", "GB"],
      ["England", "GB"],
      ["Scotland", "GB"],
      ["Wales", "GB"],
      ["Great Britain", "GB"],
      ["USA", "US"],
      ["US", "US"],
      ["États-Unis", "US"],
      ["Etats Unis", "US"],
      ["Holland", "NL"],
      ["Pays-Bas", "NL"],
      ["Deutschland", "DE"],
      ["España", "ES"],
      ["Espana", "ES"],
      ["Italia", "IT"],
      ["Belgie", "BE"],
      ["België", "BE"],
      ["Schweiz", "CH"],
      ["Türkiye", "TR"],
      ["UAE", "AE"],
      ["Czech Republic", "CZ"],
      ["Ivory Coast", "CI"],
    ];
    for (const [raw, code] of expected) expect(matchCountry(raw), raw).toBe(code);
    for (const [, code] of COUNTRY_ALIASES) expect(countryCodes).toContain(code);
  });

  test("unknown or blank countries give null", () => {
    expect(matchCountry("Atlantis")).toBeNull();
    expect(matchCountry("Narnia")).toBeNull();
    expect(matchCountry("")).toBeNull();
    expect(matchCountry("n/a")).toBeNull();
  });
});

test.describe("date order detection", () => {
  test("a first part above 12 means DMY", () => {
    const guess = detectDateOrder(["15/03/2025", "03/04/2025", "", "2025-03-15", "1.2.2024"]);
    expect(guess).toEqual({ order: "dmy", dmy: 1, mdy: 0, ambiguous: 2 });
    expect(suggestDateOrder(guess)).toBe("dmy");
  });

  test("a second part above 12 means MDY", () => {
    const guess = detectDateOrder(["03/15/2025 2:30 PM", "04/03/2025"]);
    expect(guess.order).toBe("mdy");
    expect(suggestDateOrder(guess)).toBe("mdy");
  });

  test("neither: ambiguous, DD/MM preselected", () => {
    const guess = detectDateOrder(["03/04/2025", "01.02.24", "yesterday"]);
    expect(guess).toEqual({ order: "ambiguous", dmy: 0, mdy: 0, ambiguous: 2 });
    expect(suggestDateOrder(guess)).toBe("dmy");
  });

  test("both: mixed", () => {
    const guess = detectDateOrder(["15/03/2025", "03/15/2025", "13-01-25"]);
    expect(guess).toEqual({ order: "mixed", dmy: 2, mdy: 1, ambiguous: 0 });
    expect(suggestDateOrder(guess)).toBe("dmy");
  });

  test("impossible parts are not evidence", () => {
    expect(detectDateOrder(["32/01/2023", "00/00/0000", "12/2023"]).order).toBe("ambiguous");
  });
});

test.describe("distinct values", () => {
  test("grouped by key, most frequent first, first spelling as label", () => {
    const records = [
      { row_no: 2, cells: ["A", "Cool-off"] },
      { row_no: 3, cells: ["B", "cool off"] },
      { row_no: 4, cells: ["C", "Hot lead"] },
      { row_no: 5, cells: ["D", ""] },
      { row_no: 6, cells: ["E"] },
    ];
    expect(distinctValues(records, 1)).toEqual([
      { key: "cool off", label: "Cool-off", count: 2 },
      { key: "hot lead", label: "Hot lead", count: 1 },
    ]);
    expect(distinctValues(records, -1)).toEqual([]);
  });
});
