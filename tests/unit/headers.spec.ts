import { expect, test } from "@playwright/test";
import { assignTarget, autoMap, columnFor, headerFingerprint, normaliseHeader } from "../../src/lib/import/headers";
import { dedupeHeaders } from "../../src/lib/import/parse";

const HAIDER = [
  "Company name",
  "Company owner",
  "Phone Number",
  "Email",
  "Lead Status",
  "Last Activity Date",
  "City",
  "Country/Region",
];

test.describe("header mapping", () => {
  test("normalises accents, case, parentheses and punctuation", () => {
    expect(normaliseHeader("  Téléphone ")).toBe("telephone");
    expect(normaliseHeader("Country/Region")).toBe("country region");
    expect(normaliseHeader("E-mail (pro)")).toBe("e mail");
    expect(normaliseHeader("Dernière   activité")).toBe("derniere activite");
    expect(normaliseHeader("Nom de la société")).toBe("nom de la societe");
  });

  test("Haider's exact header maps with zero clicks", () => {
    const { targets, matched } = autoMap(HAIDER);
    expect(targets).toEqual(["name", "owner", "phone", "email", "status", "last_activity", "city", "country"]);
    expect(matched.every(Boolean)).toBe(true);
  });

  test("French headers in another order, with columns nobody maps", () => {
    const headers = [
      "Ville",
      "Nom de la société",
      "Téléphone",
      "Chargé de compte",
      "E-mail",
      "Statut",
      "Pays",
      "Notes",
      "Dernière activité",
    ];
    const { targets, matched } = autoMap(headers);
    expect(targets).toEqual(["city", "name", "phone", "ignore", "email", "status", "country", "ignore", "last_activity"]);
    // "Chargé de compte" and "Notes" are left for a choice by hand.
    expect(matched[3]).toBe(false);
    expect(matched[7]).toBe(false);
  });

  test("shuffled English headers, synonyms and contains-matches", () => {
    const { targets } = autoMap(["Mobile phone", "Ville de livraison", "Société", "Owner", "Courriel", "Statut du lead"]);
    expect(targets).toEqual(["phone", "city", "name", "owner", "email", "status"]);
  });

  test("company words win over the generic Name / Nom, whatever the column order", () => {
    expect(autoMap(["Prénom", "Nom", "Société"]).targets).toEqual(["ignore", "ignore", "name"]);
    expect(autoMap(["Name", "Company name"]).targets).toEqual(["ignore", "name"]);
    expect(autoMap(["Nom", "Raison sociale", "Ville"]).targets).toEqual(["ignore", "name", "city"]);
    expect(autoMap(["Nom commercial", "Commercial"]).targets).toEqual(["name", "owner"]);
    // Alone, Name and Nom are still the company.
    expect(autoMap(["Name", "City"]).targets).toEqual(["name", "city"]);
    expect(autoMap(["Nom", "Ville"]).targets).toEqual(["name", "city"]);
    const { targets, matched } = autoMap(["Prénom", "Nom", "Société"]);
    expect(targets[1]).toBe("ignore");
    expect(matched[1]).toBe(false);
  });

  test("headers about the owner or a web domain are not the lead's email, phone or name", () => {
    expect(autoMap(["Owner email"]).targets).toEqual(["ignore"]);
    expect(autoMap(["Email Domain"]).targets).toEqual(["ignore"]);
    expect(autoMap(["Company Domain Name"]).targets).toEqual(["ignore"]);
    expect(autoMap(["Téléphone du commercial", "E-mail du responsable"]).targets).toEqual(["ignore", "ignore"]);
    expect(autoMap(["Owner email", "Email"]).targets).toEqual(["ignore", "email"]);
    // An owner word with an owner synonym is still the owner column.
    expect(autoMap(["Account owner"]).targets).toEqual(["owner"]);
    expect(autoMap(["Owner name"]).targets).toEqual(["owner"]);
    expect(autoMap(["Nom du commercial"]).targets).toEqual(["owner"]);
  });

  test("a trade name (Nom commercial, Commercial name) is the company, not the sales rep", () => {
    expect(autoMap(["Nom commercial de l'entreprise", "Commercial", "Ville"]).targets).toEqual(["name", "owner", "city"]);
    expect(autoMap(["Commercial name", "Owner"]).targets).toEqual(["name", "owner"]);
    expect(autoMap(["Nom commercial/Enseigne", "Commercial"]).targets).toEqual(["name", "owner"]);
    expect(autoMap(["Trade name", "Enseigne"]).targets).toEqual(["name", "ignore"]);
  });

  test("HubSpot Country/Region and Région map to country", () => {
    expect(autoMap(["Country/Region"]).targets).toEqual(["country"]);
    expect(autoMap(["Région"]).targets).toEqual(["country"]);
  });

  test("each field feeds from one column: a duplicate header stays Don't import", () => {
    const headers = dedupeHeaders(["Email", "Company", "email", "EMAIL"]);
    expect(headers).toEqual(["Email", "Company", "email (2)", "EMAIL (3)"]);
    expect(autoMap(headers).targets).toEqual(["email", "name", "ignore", "ignore"]);
  });

  test("empty headers are allowed and never matched", () => {
    const headers = dedupeHeaders(["Company name", "", "", "City"]);
    expect(headers).toEqual(["Company name", "", "", "City"]);
    const { targets, matched } = autoMap(headers);
    expect(targets).toEqual(["name", "ignore", "ignore", "city"]);
    expect(matched).toEqual([true, false, false, true]);
  });

  test("Row / Ligne / Problem / Problème columns of a problems file are ignored automatically", () => {
    const { targets, matched } = autoMap(["Row", "Problem", ...HAIDER]);
    expect(targets.slice(0, 2)).toEqual(["ignore", "ignore"]);
    expect(matched.slice(0, 2)).toEqual([true, true]);
    expect(targets.slice(2)).toEqual(["name", "owner", "phone", "email", "status", "last_activity", "city", "country"]);
    expect(autoMap(["Ligne", "Problème", "Société"]).targets).toEqual(["ignore", "ignore", "name"]);
  });

  test("a header named __proto__ is just a column", () => {
    const { targets } = autoMap(["__proto__", "constructor", "Company"]);
    expect(targets).toEqual(["ignore", "ignore", "name"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("picking a field already in use swaps the two columns", () => {
    const start = autoMap(HAIDER).targets;
    const swapped = assignTarget(start, 6, "country"); // City column -> country
    expect(swapped[6]).toBe("country");
    expect(swapped[7]).toBe("city");
    expect(assignTarget(swapped, 0, "ignore")[0]).toBe("ignore");
    expect(columnFor(swapped, "country")).toBe(6);
    expect(columnFor(assignTarget(swapped, 0, "ignore"), "name")).toBe(-1);
    // The input is not changed.
    expect(start[6]).toBe("city");
  });

  test("the fingerprint is stable across case and accents", () => {
    expect(headerFingerprint(["Société", "Email"])).toBe(headerFingerprint(["SOCIETE", "email"]));
    expect(headerFingerprint(["A", "B"])).not.toBe(headerFingerprint(["B", "A"]));
  });
});
