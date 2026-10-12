import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createTranslator } from "use-intl/core";

// The import screens' words (Import, StepUp, NotFound) and the lead page's (Day 4b: LeadPage, QuickActions, CallPanel,
// Composer, Outcomes, Timeline, Errors, and the Leads and Shortcuts keys it added): both languages have the same keys,
// French follows French typography (a narrow no-break space before : ; ? ! and inside « », the typographic
// apostrophe), and the counts read right in both languages, at 0 and 1 too.
type Messages = Record<string, unknown>;
const load = (locale: string) =>
  JSON.parse(readFileSync(path.join(__dirname, "..", "..", "messages", `${locale}.json`), "utf8")) as Messages;
const en = load("en");
const fr = load("fr");
const namespaces = [
  "Import",
  "StepUp",
  "NotFound",
  "LeadPage",
  "QuickActions",
  "CallPanel",
  "Composer",
  "Outcomes",
  "Timeline",
  "Errors",
  "Leads",
  "Shortcuts",
  "Inventory",
  "InventorySettings",
  "StockImport",
  "Sales",
  "Share",
  "ShareLinks",
  "ShareText",
];

function entries(node: unknown, prefix = ""): [string, string][] {
  if (typeof node === "string") return [[prefix, node]];
  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([key, value]) => entries(value, prefix ? `${prefix}.${key}` : key));
  }
  return [];
}

const say = (messages: Messages, locale: string) => {
  const t = createTranslator({ locale, messages });
  return (key: string, values?: Record<string, string | number>) => (t as (k: string, v?: Record<string, string | number>) => string)(key, values);
};

test.describe("import and lead page messages", () => {
  test("English and French have the same keys", () => {
    for (const ns of namespaces) {
      expect(entries(fr[ns]).map(([key]) => key).sort()).toEqual(entries(en[ns]).map(([key]) => key).sort());
    }
  });

  test("French typography: narrow no-break spaces and typographic apostrophes", () => {
    const bad: string[] = [];
    for (const ns of namespaces) {
      for (const [key, text] of entries(fr[ns], ns)) {
        if (/[  ][:;?!»]/.test(text) || /«[  ]/.test(text) || text.includes("'")) bad.push(`${key}: ${text}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("counts agree at 0, 1 and more", () => {
    const tf = say(fr, "fr");
    const te = say(en, "en");
    const undo = { file: "leads.csv", date: "12 oct. 2026", kept: 0, keptFormatted: "0" };
    // Nothing left to remove is never worded as one lead removed.
    expect(tf("Import.undo.body", { ...undo, removable: 0, removableFormatted: "0" })).toContain("rien ne sera supprimé");
    expect(te("Import.undo.body", { ...undo, removable: 0, removableFormatted: "0" })).toContain("nothing will be removed");
    expect(tf("Import.undo.body", { ...undo, removable: 1, removableFormatted: "1" })).toContain("le prospect ajouté depuis leads.csv le 12 oct. 2026 sur lequel personne");
    expect(tf("Import.undo.body", { ...undo, removable: 2, removableFormatted: "2" })).toContain("les 2 prospects ajoutés depuis leads.csv le 12 oct. 2026 sur lesquels personne");
    expect(te("Import.undo.body", { ...undo, removable: 399, removableFormatted: "399", kept: 1, keptFormatted: "1" })).toContain(
      "removes the 399 leads added from leads.csv on 12 oct. 2026 that nobody has worked on. 1 lead your team worked on since",
    );
    expect(tf("Import.history.status.rolled_back", { count: 1, formatted: "1" })).toBe("Annulé · 1 gardé");
    expect(tf("Import.history.status.rolled_back", { count: 0, formatted: "0" })).toBe("Annulé");
    expect(tf("Import.history.counts.rejected", { count: 1, formatted: "1" })).toBe("1 non importé");
    expect(tf("Import.undo.done", { removed: 1, removedFormatted: "1", kept: 1, keptFormatted: "1" })).toBe("1 supprimé. 1 gardé.");
    expect(te("Import.undo.done", { removed: 399, removedFormatted: "399", kept: 1, keptFormatted: "1" })).toBe("Removed 399. Kept 1.");
    const line = { file: "a.csv", separator: "," };
    expect(te("Import.match.fileLine", { ...line, rows: 1, rowsFormatted: "1", columns: 1, columnsFormatted: "1" })).toBe(
      "a.csv · 1 row · 1 column · separated by ,",
    );
    expect(te("Import.match.fileLine", { ...line, rows: 20, rowsFormatted: "20", columns: 8, columnsFormatted: "8" })).toBe(
      "a.csv · 20 rows · 8 columns · separated by ,",
    );
    expect(te("Import.check.resultsBody", { file: "a.csv", rows: 1, rowsFormatted: "1" })).toBe("a.csv · 1 row. Nothing has been added yet.");
    expect(te("Import.match.sameFile", { date: "12 Oct 2026", count: 1, formatted: "1" })).toContain("(1 lead)");
    expect(te("Import.match.ownerHint", { matched: 3, matchedFormatted: "3", total: 3, totalFormatted: "3" })).toContain(
      "We matched 3 of 3 owner names to your team.",
    );
    expect(tf("Import.match.ownerHint", { matched: 1, matchedFormatted: "1", total: 4, totalFormatted: "4" })).toContain(
      "associé 1 nom de responsable sur 4",
    );
    expect(tf("Import.check.importing", { done: 1, doneFormatted: "1", total: "5" })).toBe("1 importé sur 5");
    expect(tf("Import.undo.running", { done: 2, doneFormatted: "2", total: "5" })).toBe("2 supprimés sur 5");
  });

  test("lead page counts and the follow-up titles", () => {
    const tf = say(fr, "fr");
    const te = say(en, "en");
    expect(te("LeadPage.attempts", { count: 1 })).toBe("1 try in a row without reaching anyone");
    expect(te("LeadPage.attempts", { count: 3 })).toBe("3 tries in a row without reaching anyone");
    expect(tf("LeadPage.attempts", { count: 1 })).toBe("1 essai d’affilée sans joindre personne");
    expect(tf("LeadPage.attempts", { count: 2 })).toBe("2 essais d’affilée sans joindre personne");
    expect(te("CallPanel.away", { minutes: 3 })).toBe("Away about 3 min");
    expect(te("Outcomes.taskTitle.followUp", { lead: "Maison Verdane" })).toBe("Follow up with Maison Verdane");
    expect(tf("Outcomes.taskTitle.rightNumber", { lead: "Maison Verdane" })).toBe("Trouver le bon numéro de Maison Verdane");
    expect(tf("LeadPage.position", { index: "3", total: "1 204" })).toBe("3 sur 1 204");
    expect(tf("Leads.until.title")).toBe("Jusqu’à quand\u202f?");
  });

  test("every call outcome, kind of entry and database hint has words in both languages", () => {
    for (const messages of [en, fr]) {
      const t = messages as Record<string, Record<string, unknown>>;
      for (const o of ["no_answer", "voicemail", "wrong_number", "not_interested", "interested", "meeting_booked", "do_not_contact", "connected", "sent", "held", "no_show"]) {
        expect(typeof t.Outcomes[o]).toBe("string");
      }
      for (const k of ["call", "email", "whatsapp", "meeting", "note"]) expect(typeof (t.Composer.types as Record<string, unknown>)[k]).toBe("string");
      for (const h of ["outcome", "body_required", "body_too_long", "body_chars", "dialled", "follow_up_required", "follow_up_range", "task_title", "bounds", "zone_not_in_country", "until_cool_off_only", "state", "task_kind", "task_due"]) {
        expect(typeof (t.Errors.hint as Record<string, unknown>)[h]).toBe("string");
      }
    }
  });
});
