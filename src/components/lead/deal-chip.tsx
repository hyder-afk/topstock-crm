"use client";

import { useLocale, useTranslations } from "next-intl";
import { Handshake } from "lucide-react";
import { Select } from "@/components/ui/select";
import type { LeadDetail } from "@/lib/leads";
import { formatMoney } from "@/lib/money";

// The lead header's deal chip (Day 5 design 7.9): "Deal: Qualified · €22,000" for the latest open deal; it opens the
// Deals tab. Nothing when the lead has no open deal the viewer sees.
export function DealChip({ lead, onShow }: { lead: LeadDetail; onShow: () => void }) {
  const t = useTranslations("LeadPage.deals");
  const tStage = useTranslations("Stages");
  const locale = useLocale();
  const latest = lead.deals?.latest_open;
  if (!latest) return null;
  const text = latest.value ? t("chip", { stage: tStage(latest.stage), value: formatMoney(latest.value, locale) }) : t("chipNoValue", { stage: tStage(latest.stage) });
  return (
    <button
      type="button"
      onClick={onShow}
      aria-label={`${text}. ${t("chipLabel")}`}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-md bg-card px-2.5 text-sm transition-[background-color,scale] duration-150 hover:bg-muted active:scale-[0.97] sm:min-h-8"
    >
      <Handshake aria-hidden="true" strokeWidth={1.75} className="size-4 text-muted-foreground" />
      <span>{text}</span>
    </button>
  );
}

/**
 * The composer's deal chip (Day 5 design 7.9): with an open deal, an entry carries it by default ("About: the deal"),
 * removable; with several open deals the chip's menu chooses one or none. `value` null means no deal.
 */
export function ComposerDealChip({
  deals,
  value,
  onChange,
}: {
  deals: { id: string; title: string | null; stage: import("@/lib/deals").StageKey }[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const t = useTranslations("Composer");
  const tD = useTranslations("Deals");
  const tStage = useTranslations("Stages");
  if (deals.length === 0) return null;
  const chosen = deals.find((d) => d.id === value) ?? null;
  const label = (d: (typeof deals)[number]) => `${d.title ?? tD("untitled")} · ${tStage(d.stage)}`;
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("aboutLabel")}>
      {deals.length > 1 ? (
        <Select
          name="about_deal"
          aria-label={t("aboutChoose")}
          value={value ?? ""}
          onValueChange={(v) => onChange(v || null)}
          className="w-auto max-w-full text-sm sm:min-h-9"
        >
          <option value="">{t("aboutNone")}</option>
          {deals.map((d) => (
            <option key={d.id} value={d.id}>
              {t("about", { deal: label(d) })}
            </option>
          ))}
        </Select>
      ) : chosen ? (
        <span className="inline-flex min-h-9 max-w-full items-center gap-1 rounded-md bg-muted pl-2.5 text-sm">
          <span className="truncate">{t("about", { deal: label(chosen) })}</span>
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label={t("aboutRemove")}
            className="grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground transition-[color,scale] duration-150 hover:text-foreground active:scale-[0.97] sm:size-9"
          >
            <span aria-hidden="true">×</span>
          </button>
        </span>
      ) : (
        <button type="button" onClick={() => onChange(deals[0].id)} className="min-h-11 rounded-md px-2 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline active:opacity-60 sm:min-h-9">
          {t("aboutLabel")}
        </button>
      )}
    </div>
  );
}
