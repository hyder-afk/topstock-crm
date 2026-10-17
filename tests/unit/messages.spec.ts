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
  "Queue",
  "Tasks",
  "Profile",
  // Day 5b: the pipeline, deals and their words in the lead page, the call panel and the command menu.
  "Stages",
  "Pipeline",
  "Deals",
  "LostReasons",
  "Fulfilment",
  "Palette",
  "Files",
  // Day 5c: the Home dashboard.
  "Home",
  // Day 6: inventory, the stock sheet import, sales and the client stock link.
  "Inventory",
  "InventorySettings",
  "StockImport",
  "Sales",
  "Share",
  "ShareLinks",
  "ShareText",
  "Pickers",
  // Day 7a: More (sign out of all devices).
  "More",
  // Analytics P2: the page shell and the "This period" charts.
  "Analytics",
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

  test("queue and tasks counts (Day 4c)", () => {
    const tf = say(fr, "fr");
    const te = say(en, "en");
    expect(te("Queue.notSaved", { count: 1 })).toBe("1 outcome not saved");
    expect(te("Queue.notSaved", { count: 2 })).toBe("2 outcomes not saved");
    expect(tf("Queue.notSaved", { count: 1 })).toBe("1 résultat non enregistré");
    expect(tf("Queue.notSaved", { count: 3 })).toBe("3 résultats non enregistrés");
    expect(te("Queue.reason.retryNth", { count: 2 })).toBe("Retry · 2nd try");
    expect(te("Queue.reason.retryNth", { count: 3 })).toBe("Retry · 3rd try");
    expect(te("Queue.reason.retryNth", { count: 11 })).toBe("Retry · 11th try");
    expect(tf("Queue.reason.retryNth", { count: 1 })).toBe("Nouvel essai · 1er appel");
    expect(tf("Queue.reason.retryNth", { count: 3 })).toBe("Nouvel essai · 3e appel");
    expect(te("Queue.stats", { calls: 1, talks: 0 })).toBe("This session: 1 call · 0 talks");
    expect(tf("Queue.stats", { calls: 23, talks: 4 })).toBe("Cette session\u202f: 23 appels · 4 échanges");
    expect(te("Queue.empty.noNumber", { count: 1 })).toBe("1 lead has no number.");
    expect(tf("Queue.empty.noNumber", { count: 1203 })).toContain("prospects n’ont pas de numéro.");
    expect(tf("Tasks.deleteConfirm.title")).toBe("Supprimer cette tâche\u202f?");
    expect(te("LeadPage.workedBy", { name: "Henri", time: "10:24" })).toBe("Henri is on this lead in the queue (until 10:24)");
    expect(te("Queue.lostClaimNamed", { name: "Henri" })).toBe("Henri is on that one now. Here’s the next.");
    expect(tf("Queue.lostClaimNamed", { name: "Henri" })).toBe("Henri s’en occupe déjà. Voici le suivant.");
    expect(tf("Queue.released.body")).toContain("onglet)\u202f: les prospects");
    expect(tf("Queue.released.logCall", { lead: "Dupont SARL" })).toBe("Noter votre appel à Dupont SARL");
    expect(te("Queue.script.enNoName", { lead: "Dupont SARL" })).toContain("I’m calling from TopStock Wholesale");
    expect(tf("Queue.script.frNoName", { lead: "Dupont SARL" })).toContain("pour Dupont SARL\u202f?");
  });

  test("no stray symbols; the French call script reads the same in the English interface (Day 4c)", () => {
    // U+237D (a shouldered open box) once stood in for the narrow no-break space in en.json's French script.
    for (const locale of ["en", "fr"]) {
      const raw = readFileSync(path.join(__dirname, "..", "..", "messages", `${locale}.json`), "utf8");
      expect(raw.includes("\u237d"), `${locale}.json has U+237D`).toBe(false);
    }
    const scriptsEn = en.Queue as { script: Record<string, string> };
    const scriptsFr = fr.Queue as { script: Record<string, string> };
    for (const key of ["fr", "frNoName", "en", "enNoName"]) expect(scriptsEn.script[key]).toBe(scriptsFr.script[key]);
    for (const key of ["fr", "frNoName"]) {
      const text = scriptsEn.script[key];
      expect(/[ \u00a0][:;?!»]/.test(text) || text.includes("'"), `en.json Queue.script.${key}`).toBe(false);
    }
  });

  test("key hints break only at the separators (Day 4c)", () => {
    for (const messages of [en, fr]) {
      const m = messages as Record<string, Record<string, string>>;
      for (const text of [m.Queue.keysHint, m.Queue.confirmKeys, m.Tasks.keysHint]) {
        // Each "key word" part holds no ordinary space; the parts are joined by " · ".
        for (const part of text.split(" · ")) expect(part.includes(" "), part).toBe(false);
        expect(text.split(" · ").length).toBeGreaterThan(1);
      }
    }
  });

  test("the Tasks title count says what it counts (Day 4c)", () => {
    expect(say(en, "en")("Tasks.dueCount", { count: 1 })).toBe("1 task due today or overdue");
    expect(say(en, "en")("Tasks.dueCount", { count: 5 })).toBe("5 tasks due today or overdue");
    expect(say(fr, "fr")("Tasks.dueCount", { count: 0 })).toBe("0 tâche pour aujourd’hui ou en retard");
    expect(say(fr, "fr")("Tasks.dueCount", { count: 2 })).toBe("2 tâches pour aujourd’hui ou en retard");
  });

  test("the Home Low stock card's counts (Day 6's stock_alerts) at 0, 1 and more", () => {
    const te = say(en, "en");
    const tf = say(fr, "fr");
    expect(te("Home.lowStock.summary", { low: 3, soldOut: 1 })).toBe("3 low · 1 sold out");
    expect(tf("Home.lowStock.summary", { low: 3, soldOut: 1 })).toBe("3 en stock bas · 1 épuisé");
    expect(tf("Home.lowStock.summary", { low: 1200, soldOut: 2 })).toBe("1 200 en stock bas · 2 épuisés");
    expect(tf("Home.lowStock.available", { available: "120", reorder: "200" })).toBe("Disponible : 120 · seuil : 200");
    // Sentence case mid-line, like the lines around it (the Day 6 status name "In Transit" is a label, not this line).
    expect(te("Home.lowStock.inTransit", { count: "300" })).toBe("+300 in transit");
    expect(tf("Home.lowStock.inTransit", { count: "1 200" })).toBe("+1 200 en transit");
    expect(te("Home.lowStock.arrivingLate", { count: 1 })).toBe("1 arrival past its expected date");
    expect(te("Home.lowStock.arrivingLate", { count: 2 })).toBe("2 arrivals past their expected date");
    expect(tf("Home.lowStock.arrivingLate", { count: 1 })).toBe("1 arrivage en retard sur la date prévue");
    expect(te("Home.lowStock.requestsNew", { count: 1 })).toBe("1 new stock request");
    expect(tf("Home.lowStock.requestsNew", { count: 4 })).toBe("4 nouvelles demandes de stock");
    expect(te("Home.lowStock.holdsEndingSoon", { count: 1 })).toBe("1 hold ends within 2 days");
    expect(te("Home.lowStock.holdsEndingSoon", { count: 3 })).toBe("3 holds end within 2 days");
    expect(tf("Home.lowStock.holdsEndingSoon", { count: 1 })).toBe("1 réservation se termine sous 2 jours");
    expect(tf("Home.lowStock.holdsEndingSoon", { count: 2 })).toBe("2 réservations se terminent sous 2 jours");
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

// Day 7c: the French pass covers every namespace, not only the ones listed above.
test.describe("the whole French file (Day 7c)", () => {
  const enAll = new Map(entries(en));
  const frAll = new Map(entries(fr));

  // French values that may equal the English one: brand names and the tagline, words spelt the same in French,
  // units and codes Haider chose for both languages (pieces are "pcs", 11 Oct 2026), and patterns made only of
  // arguments and symbols. Anything else identical is an English string left in fr.json.
  const sameInBoth = new Set([
    // Brand and product names.
    "Metadata.title",
    "Home.tagline",
    "Share.meta.title",
    "ShareText.company",
    "ShareText.signature",
    "QuickActions.whatsapp",
    "Composer.types.whatsapp",
    "Timeline.filters.whatsapp",
    "LeadPage.whatsappContact",
    // The same word in French.
    "Home.pipeline.title",
    "Nav.pipeline",
    "Shortcuts.pipeline.title",
    "Pipeline.title",
    "Team.role.admin",
    "Team.role.manager",
    "Team.moreSection",
    "Nav.label",
    "Palette.actions",
    "Leads.preview.contactsTitle",
    "Queue.contacts",
    "Deals.fields.contact",
    "Import.steps.import",
    "LeadPage.details.import",
    "Import.match.dateTitle",
    "Composer.date",
    "Tasks.quickAdd.date",
    "LeadPage.tabs.stock",
    "Inventory.tabs.stock",
    "Inventory.table.label",
    "QuickActions.note",
    "CallPanel.note",
    "Composer.types.note",
    "Composer.noteLabel",
    "Timeline.filters.note",
    "Deals.lose.note",
    "Queue.note",
    "Sales.sheet.note",
    "Sales.hold.note",
    "Sales.request.note",
    "Composer.emailBody",
    "Inventory.reasons.correction",
    "Inventory.movement.correction",
    "Sales.sheet.total",
    "Sales.list.lineTotal",
    "Sales.sheet.minMax",
    // Analytics P2: the brand name WhatsApp and bare placeholders ({count}, "{day} {hour}", "{count} ({share})").
    "Analytics.calls.whatsapp",
    "Analytics.calls.table.whatsapp",
    "Analytics.team.whatsapp",
    "Analytics.calls.miniTotal",
    "Analytics.lost.tooltip",
    "Analytics.heat.slot",
    // Analytics P3: the bare placeholder "{rate} ({count})" of list quality.
    "Analytics.listQuality.share",
    // Units and codes kept in both languages.
    "Inventory.units.pcs",
    "Inventory.units.ctn",
    "Inventory.units.ctnPlus",
    "Inventory.units.pcsShort",
    "Inventory.units.ctnShort",
    "Inventory.table.carton",
    "Inventory.kpi.pcs",
    "Sales.tab.piecesCount",
    "Share.item.pcs",
    "Share.item.ctn",
    "Share.item.equals",
    "Share.item.equalsCartons",
    "ShareText.perPiece",
    "Share.ref",
    "Pickers.monthLetters",
    "Pickers.timePattern24",
    "Pickers.timePattern12",
    // Arguments and symbols only.
    "Import.history.when",
    "StockImport.history.when",
    "StockImport.check.beforeAfter",
    "Pipeline.lostReason",
    "Deals.nextTo",
    "Deals.lose.noteCount",
    "Share.basket.line",
    "Share.basket.counter",
    "ShareLinks.hint",
    // The call scripts: both files hold both languages (the caller picks the script's language, not the interface's).
    "Queue.script.en",
    "Queue.script.enNoName",
    "Queue.script.fr",
    "Queue.script.frNoName",
  ]);
  // English text or spreadsheet codes inside fr.json, outside the French typography rules.
  const notFrenchProse = new Set(["Queue.script.en", "Queue.script.enNoName", "StockImport.problems.excel_error"]);

  test("every key in both languages, across every namespace", () => {
    expect([...frAll.keys()].sort()).toEqual([...enAll.keys()].sort());
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
  });

  test("French values equal to English only where the allowlist says so", () => {
    const same = [...enAll].filter(([key, text]) => frAll.get(key) === text).map(([key]) => key);
    expect(same.filter((key) => !sameInBoth.has(key))).toEqual([]);
    // The allowlist names live keys only, so it cannot hide a key that is gone.
    expect([...sameInBoth].filter((key) => !enAll.has(key))).toEqual([]);
  });

  test("the same arguments and tags in both languages", () => {
    // French may count on the raw number where English counts on another one, so "doneFormatted" and "done" (or
    // "formatted" and "count") stand for the same value.
    const value = (name: string) => (name === "formatted" ? "count" : name.replace(/Formatted$/, ""));
    const shape = (text: string) => ({
      args: [...new Set(icuArgs(text).map(value))].sort(),
      tags: [...new Set(text.match(/<\/?[A-Za-z]+>/g) ?? [])].sort(),
    });
    const bad = [...enAll].filter(([key, text]) => JSON.stringify(shape(text)) !== JSON.stringify(shape(frAll.get(key) ?? "")));
    expect(bad.map(([key]) => key)).toEqual([]);
  });

  test("French typography in every namespace", () => {
    const bad: string[] = [];
    for (const [key, text] of frAll) {
      if (notFrenchProse.has(key)) continue;
      const rules: [string, boolean][] = [
        // A narrow no-break space (U+202F) before ; ? ! » and after «, never an ordinary or a wide no-break space.
        ["space before ; ? ! »", /[^ ][;?!»]/.test(text)],
        ["space after «", /«[^ ]/.test(text)],
        // A colon in prose (end of text or followed by a space) has one too; "hh:mm" and "{a}:{b}" are not prose.
        ["space before :", /[^ ]:(\s|$)/.test(text)],
        // Numbers hold together: thousands by U+202F, a unit by a no-break space, as Intl writes them in fr-FR.
        ["plain space in a number", /\d \d{3}(?!\d)|\d (€|%|Mo|Ko|Go)/.test(text)],
        ["typewriter apostrophe", text.includes("'")],
        ["three dots", text.includes("...")],
      ];
      for (const [rule, broken] of rules) if (broken) bad.push(`${key} (${rule}): ${text}`);
    }
    expect(bad).toEqual([]);
  });
});

/** The argument names of an ICU message, including those inside plural and select options (not the option keys). */
function icuArgs(text: string): string[] {
  const names = new Set<string>();
  let i = 0;
  const skipBlock = () => {
    for (let depth = 1; i < text.length && depth > 0; i++) depth += text[i] === "{" ? 1 : text[i] === "}" ? -1 : 0;
  };
  const message = (nested: boolean) => {
    while (i < text.length) {
      const c = text[i];
      if (c === "}" && nested) return;
      i++;
      if (c === "{") argument();
    }
  };
  const argument = () => {
    const name = /^\s*([A-Za-z_]\w*)\s*/.exec(text.slice(i));
    if (!name) return skipBlock();
    names.add(name[1]);
    i += name[0].length;
    if (text[i] === "}") {
      i++;
      return;
    }
    i++; // the comma after the name
    const type = /^\s*(\w+)\s*/.exec(text.slice(i));
    i += type ? type[0].length : 0;
    if (!type || !["plural", "select", "selectordinal"].includes(type[1])) return skipBlock();
    if (text[i] === ",") i++;
    while (i < text.length && text[i] !== "}") {
      if (text[i] === "{") {
        i++;
        message(true);
      }
      i++;
    }
    i++;
  };
  message(false);
  return [...names].sort();
}
