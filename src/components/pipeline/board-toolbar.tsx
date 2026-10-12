"use client";

import { useFormatter, useLocale, useTranslations } from "next-intl";
import { ArrowUpDown, Check, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { sortOrders, type SortOrder } from "@/lib/deals";
import { personName, type TeamMember } from "@/lib/leads";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";

// The board's toolbar (Day 5 design 7.1): "Pipeline" (h1) and the totals badge; Team · Mine (managers and admins); owner
// chips (Team view); "Stalled only" with its count; the sort menu (Value and Close date sort the loaded cards only); and
// New deal, the one red button on the page. Two rows at 768; at 390 the owner chips scroll in their own row and New
// deal is full width.
export function BoardToolbar({
  total,
  canTeam,
  scope,
  onScope,
  owner,
  onOwner,
  team,
  stalledOnly,
  stalledCount,
  onStalled,
  order,
  onOrder,
  onNewDeal,
  status,
}: {
  total: { count: number; value: string };
  canTeam: boolean;
  scope: "team" | "mine";
  onScope: (s: "team" | "mine") => void;
  owner: string | null;
  onOwner: (id: string | null) => void;
  team: TeamMember[];
  stalledOnly: boolean;
  stalledCount: number;
  onStalled: (on: boolean) => void;
  order: SortOrder;
  onOrder: (o: SortOrder) => void;
  onNewDeal: () => void;
  status: React.ReactNode;
}) {
  const t = useTranslations("Pipeline");
  const locale = useLocale();
  const format = useFormatter();
  const chip = (on: boolean) =>
    cn(
      "inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm transition-[background-color,color,transform] duration-150 active:scale-[0.97] sm:min-h-9",
      on ? "bg-primary text-primary-foreground" : "bg-card text-foreground hover:bg-muted",
    );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-3xl font-bold sm:text-4xl">{t("title")}</h1>
          <span className="rounded-sm bg-card px-2 py-1 font-mono text-sm tabular-nums">
            {t("totals", { count: total.count, value: formatMoney(total.value, locale) })}
          </span>
        </div>
        <Button variant="brand" onClick={onNewDeal} className="max-sm:w-full">
          <Plus aria-hidden="true" strokeWidth={2} className="size-4" />
          {t("newDeal")}
          <Kbd aria-hidden="true" className="ml-1 hidden border-transparent bg-brand-foreground/10 text-brand-foreground sm:inline-grid">
            N
          </Kbd>
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {canTeam ? (
          <div role="radiogroup" aria-label={t("scope.label")} className="flex rounded-md bg-muted p-1">
            {(["team", "mine"] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={scope === s}
                onClick={() => onScope(s)}
                className={cn(
                  "min-h-11 rounded-sm px-3 text-sm font-bold transition-[background-color,color,transform] duration-150 active:scale-[0.97] sm:min-h-8",
                  scope === s ? "bg-pill text-foreground shadow-[0_1px_2px_rgb(14_14_16/0.12)]" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t(`scope.${s}`)}
              </button>
            ))}
          </div>
        ) : null}
        {canTeam && scope === "team" ? (
          <div role="group" aria-label={t("owners.label")} className="-mx-4 flex max-w-[calc(100%+32px)] gap-1.5 overflow-x-auto px-4 sm:mx-0 sm:max-w-full sm:px-0">
            <button type="button" aria-pressed={owner === null} onClick={() => onOwner(null)} className={chip(owner === null)}>
              {t("owners.everyone")}
            </button>
            {team.map((m) => (
              <button key={m.id} type="button" aria-pressed={owner === m.id} onClick={() => onOwner(owner === m.id ? null : m.id)} className={chip(owner === m.id)}>
                {personName(m) || m.first_name}
              </button>
            ))}
          </div>
        ) : null}
        <button type="button" aria-pressed={stalledOnly} onClick={() => onStalled(!stalledOnly)} className={chip(stalledOnly)}>
          {stalledOnly ? <Check aria-hidden="true" strokeWidth={2} className="size-4" /> : <span aria-hidden="true" className="size-1.5 rounded-full bg-status-amber" />}
          {t("stalledOnly")}
          <span className="font-mono text-xs tabular-nums opacity-80">{format.number(stalledCount)}</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger className={chip(false)}>
            <ArrowUpDown aria-hidden="true" strokeWidth={1.75} className="size-4" />
            {t("sort.label", { order: t(`sort.${order}`) })}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup value={order} onValueChange={(v) => onOrder(v as SortOrder)}>
              {sortOrders.map((o) => (
                <DropdownMenuRadioItem key={o} value={o}>
                  {t(`sort.${o}`)}
                  {o === "value" || o === "close" ? <span aria-hidden="true" className="text-muted-foreground">*</span> : null}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <p className="px-3 pt-1 pb-2 text-xs text-muted-foreground">* {t("sort.loadedNote")}</p>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="ml-auto text-sm text-muted-foreground">{status}</div>
      </div>
    </div>
  );
}
