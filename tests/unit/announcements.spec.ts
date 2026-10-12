import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createTranslator } from "use-intl/core";
import type { Active, Over } from "@dnd-kit/core";
import { buildAnnouncements, buildInstructions } from "@/components/pipeline/announcements";

// What a screen reader hears during a drag (Day 5 design 7.8), in English and French, plain text with every value filled.
const load = (locale: string) => JSON.parse(readFileSync(path.join(__dirname, "..", "..", "messages", `${locale}.json`), "utf8"));

for (const locale of ["en", "fr"] as const) {
  test(`announcements are filled in ${locale}`, () => {
    const messages = load(locale);
    const t = createTranslator({ locale, messages, namespace: "Pipeline.announce" }) as unknown as (k: string, v?: Record<string, string>) => string;
    const stages = createTranslator({ locale, messages, namespace: "Stages" }) as unknown as (k: string) => string;
    const a = buildAnnouncements(t, (id) => (id === "d1" ? { lead: "Maison Verdane", value: "12 400 €", stage: stages("qualified") } : null), (id) => stages(id));
    const active = { id: "d1" } as unknown as Active;
    const over = (id: string) => ({ id }) as unknown as Over;
    const lines = [
      a.onDragStart({ active }),
      a.onDragOver({ active, over: over("negotiations") }),
      a.onDragOver({ active, over: null }),
      a.onDragEnd({ active, over: over("negotiations") }),
      a.onDragEnd({ active, over: over("won") }),
      a.onDragEnd({ active, over: over("qualified") }),
      a.onDragCancel({ active, over: null }),
      buildInstructions(t).draggable,
    ];
    for (const line of lines) {
      expect(line, String(line)).toBeTruthy();
      expect(line).not.toMatch(/[{}<>]/);
    }
    expect(lines[0]).toContain("Maison Verdane");
    expect(lines[3]).toContain(stages("negotiations"));
    expect(lines[5]).toBe(lines[6]); // dropped back on its own column: the cancel line
    if (locale === "en") {
      expect(lines[0]).toBe("Picked up Maison Verdane, 12 400 €, in Qualified.");
      expect(lines[3]).toBe("Moved Maison Verdane to Negotiations. Press U to undo.");
      expect(lines[4]).toBe("Maison Verdane dropped on Closed/won. Confirm in the dialog.");
    } else {
      expect(lines[0]).toBe("Maison Verdane, 12 400 €, prise dans Qualifiée.");
      expect(lines[3]).toBe("Maison Verdane déplacée vers Négociation. Appuyez sur U pour annuler.");
    }
    expect(a.onDragStart({ active: { id: "missing" } as unknown as Active })).toBeUndefined();
  });
}
