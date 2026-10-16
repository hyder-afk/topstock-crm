"use client";

import { useRef } from "react";
import { useTranslations } from "next-intl";
import { Check } from "lucide-react";
import type { DealCard, StageKey } from "@/lib/deals";
import { cn } from "@/lib/utils";

// The stage stepper (Day 5 design 7.6): Lead → Qualified → Negotiations → Won, with "Mark lost" beside it. The main way
// to move a deal on a phone. A radio group: arrow keys move the focus between stages, Enter or Space picks one (Won and
// Lost open their dialogs). 44 px targets; the current stage is the neutral fill (status colours never fill controls).
const STEPS = ["lead", "qualified", "negotiations", "won"] as const;

export function StageStepper({
  card,
  onPick,
  onLose,
  disabled,
  describedBy,
}: {
  card: Pick<DealCard, "stage" | "status">;
  onPick: (stage: StageKey) => void;
  onLose: () => void;
  disabled: boolean;
  /** The id of the text that says why the stepper is off (Day 7f: stock records hold the deal). */
  describedBy?: string;
}) {
  const t = useTranslations("Deals.sheet");
  const tStage = useTranslations("Stages");
  const group = useRef<HTMLDivElement>(null);
  const current = STEPS.indexOf(card.stage as (typeof STEPS)[number]);
  return (
    <div className="flex flex-col gap-2">
      <div ref={group} role="radiogroup" aria-label={t("stepper")} aria-describedby={describedBy} aria-disabled={disabled || undefined} className="grid grid-cols-4 gap-1 rounded-md bg-muted p-1">
        {STEPS.map((s, i) => {
          const on = card.stage === s;
          const done = current > i || card.stage === "won";
          return (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled}
              tabIndex={on || (current < 0 && i === 0) ? 0 : -1}
              data-step={s}
              onClick={() => !on && onPick(s)}
              onKeyDown={(e) => {
                const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
                if (!step) return;
                e.preventDefault();
                const next = STEPS[Math.min(STEPS.length - 1, Math.max(0, i + step))];
                group.current?.querySelector<HTMLElement>(`[data-step="${next}"]`)?.focus();
              }}
              className={cn(
                "flex min-h-11 min-w-0 items-center justify-center gap-1 rounded-sm px-1 text-xs font-bold transition-[background-color,color,scale] duration-150 active:scale-[0.97] disabled:opacity-60 sm:text-[13px]",
                on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {done && !on ? <Check aria-hidden="true" strokeWidth={2} className="size-3.5 shrink-0" /> : null}
              <span className="truncate">{tStage(`short.${s}`)}</span>
            </button>
          );
        })}
      </div>
      {card.status === "open" && !disabled ? (
        <button type="button" onClick={onLose} className="min-h-11 self-start rounded-md px-1 text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline sm:min-h-9">
          {t("markLost")}
        </button>
      ) : null}
    </div>
  );
}
