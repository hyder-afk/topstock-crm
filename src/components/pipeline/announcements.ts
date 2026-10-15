import type { Announcements, ScreenReaderInstructions } from "@dnd-kit/core";

// What a screen reader hears during a drag (Day 5 design 7.8), in the person's language, as plain text from
// messages/* (never HTML). dnd-kit reads these into its live region. Unit-tested (tests/unit/announcements.spec.ts).
type T = (key: string, values?: Record<string, string>) => string;
export type CardFacts = { lead: string; value: string; stage: string };

export function buildAnnouncements(
  t: T,
  facts: (id: string) => CardFacts | null,
  stageName: (id: string) => string,
): Announcements {
  // The target last announced. dnd-kit reports the card's own column as "over" a frame after pick-up; saying
  // "Over Lead." then would cut off "Picked up ..." in the live region, so a target is only announced when it changes.
  let last: string | null = null;
  return {
    onDragStart: ({ active }) => {
      const stage = active.data?.current?.stage;
      last = typeof stage === "string" ? stage : null;
      const f = facts(String(active.id));
      return f ? t("start", { lead: f.lead, value: f.value, stage: f.stage }) : undefined;
    },
    onDragOver: ({ over }) => {
      const id = over ? String(over.id) : null;
      if (id === last) return undefined;
      last = id;
      return id ? t("over", { stage: stageName(id) }) : t("overNone");
    },
    onDragEnd: ({ active, over }) => {
      const f = facts(String(active.id));
      if (!f) return undefined;
      if (!over || stageName(String(over.id)) === f.stage) return t("cancel", { lead: f.lead, stage: f.stage });
      const target = String(over.id);
      return target === "won" || target === "lost"
        ? t("endClosed", { lead: f.lead, stage: stageName(target) })
        : t("end", { lead: f.lead, stage: stageName(target) });
    },
    onDragCancel: ({ active }) => {
      const f = facts(String(active.id));
      return f ? t("cancel", { lead: f.lead, stage: f.stage }) : undefined;
    },
  };
}

export function buildInstructions(t: T): ScreenReaderInstructions {
  return { draggable: t("instructions") };
}
