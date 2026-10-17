"use client";

import { useLocale, useTranslations } from "next-intl";
import { Kbd } from "@/components/ui/kbd";
import type { StageKey } from "@/lib/deals";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";

// "Open a deal" for Interested (5) and Book meeting (6), shared by the call panel and the work queue (Day 5 design 7.9,
// D17): a switch (D toggles it; aria-keyshortcuts="D"), on when the lead has no open deal; when it is off because one is
// open, "Already has an open deal: Qualified · €6,800"; when on, an optional title and value. Shown only to people who
// may change the lead (the caller hides it otherwise).
export function OpenDealSwitch({
  on,
  onToggle,
  latest,
  openCount,
  title,
  onTitle,
  value,
  onValue,
  valueBad,
}: {
  on: boolean;
  onToggle: () => void;
  latest: { stage: StageKey; value: string | null } | null;
  openCount: number;
  title: string;
  onTitle: (v: string) => void;
  value: string;
  onValue: (v: string) => void;
  valueBad: boolean;
}) {
  const tOut = useTranslations("Outcomes");
  const tStage = useTranslations("Stages");
  const locale = useLocale();
  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted/60 p-3">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-keyshortcuts="D"
        onClick={onToggle}
        className="flex min-h-11 items-center justify-between gap-3 text-left text-sm font-bold transition-[scale] duration-150 active:scale-[0.97]"
      >
        <span>{tOut("openDeal")}</span>
        <span className="flex items-center gap-2">
          <Kbd aria-hidden="true">D</Kbd>
          <span aria-hidden="true" className={cn("relative h-6 w-10 rounded-full transition-colors duration-150", on ? "bg-primary" : "bg-border")}>
            <span className={cn("absolute top-0.5 size-5 rounded-full bg-card shadow-sm transition-[translate] duration-150 motion-reduce:transition-none", on ? "translate-x-[18px]" : "translate-x-0.5")} />
          </span>
        </span>
      </button>
      {!on && openCount > 0 && latest ? (
        <p className="text-xs text-muted-foreground">
          {latest.value
            ? tOut("dealOpen", { stage: tStage(latest.stage), value: formatMoney(latest.value, locale) })
            : tOut("dealOpenNoValue", { stage: tStage(latest.stage) })}
        </p>
      ) : null}
      {on ? (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,7rem)] gap-2">
          <label className="flex min-w-0 flex-col gap-1 text-xs">
            <span className="text-muted-foreground">{tOut("dealTitle")}</span>
            <input
              name="deal_title"
              autoComplete="off"
              dir="auto"
              maxLength={120}
              value={title}
              onChange={(e) => onTitle(e.target.value)}
              className="min-h-11 rounded-md border border-border bg-background px-2 text-sm text-foreground"
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs">
            <span className="text-muted-foreground">{tOut("dealValue")}</span>
            <input
              name="deal_value"
              inputMode="decimal"
              autoComplete="off"
              value={value}
              onChange={(e) => onValue(e.target.value)}
              aria-invalid={valueBad || undefined}
              className="min-h-11 rounded-md border border-border bg-background px-2 font-mono text-sm text-foreground aria-invalid:border-status-red"
            />
          </label>
          {valueBad ? <p className="col-span-2 text-xs text-status-red">{tOut("dealValueInvalid")}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
