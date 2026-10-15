"use client";

import { useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/lead/lead-cards";
import { MiniStepper } from "@/components/lead/deals-tab";
import { elapsedDays } from "@/lib/deals";
import { personName, type LeadDetail } from "@/lib/leads";
import { formatMoney } from "@/lib/money";

// The Summary tab's deal card (Day 5 design 7.9; replaces Day 4b's placeholder): the latest open deal from get_lead's
// deals brief (no extra call): the mini stepper, the stage, the value, days in stage or Stalled; "+1 more open deal" and
// "Open on the board". With no open deal: the empty line and, for editors, Open a deal.
export function DealSummaryCard({ lead, onOpenDeal, onNewDeal, onShowDeals }: { lead: LeadDetail; onOpenDeal: (id: string) => void; onNewDeal: () => void; onShowDeals: () => void }) {
  const t = useTranslations("LeadPage.deals");
  const tLead = useTranslations("LeadPage");
  const tLeads = useTranslations("Leads");
  const tD = useTranslations("Deals");
  const tStage = useTranslations("Stages");
  const locale = useLocale();
  const [now] = useState(() => Date.now());
  const brief = lead.deals;
  const latest = brief?.latest_open ?? null;
  const more = Math.max(0, (brief?.open_count ?? 0) - 1);
  const canOpen = lead.can_open_deal ?? lead.can_edit;
  const ownerName = lead.owner ? personName(lead.owner) || tLeads("noName") : null;
  return (
    <Card title={t("summaryTitle")}>
      {latest ? (
        <div className="flex flex-col gap-2">
          <button type="button" onClick={() => onOpenDeal(latest.id)} className="flex min-h-11 flex-col items-start gap-1 rounded-md text-left transition-colors hover:bg-muted/60">
            <span className="flex items-center gap-2">
              <MiniStepper stage={latest.stage} />
              <span className="text-sm font-bold">{latest.title ?? tD("untitled")}</span>
            </span>
            <span className="text-sm text-muted-foreground">
              {tStage(latest.stage)} · <span className="font-mono">{latest.value ? formatMoney(latest.value, locale) : tD("addValue")}</span> ·{" "}
              {latest.is_stalled ? (
                <span className="inline-flex items-center gap-1">
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-status-amber" />
                  <span className="text-status-amber">{tD("stalled")}</span>
                </span>
              ) : (
                tD("daysInStage", { count: elapsedDays(latest.stage_entered_at, now) })
              )}
            </span>
          </button>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            {more > 0 ? (
              <button type="button" onClick={onShowDeals} className="min-h-11 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline sm:min-h-0">
                {t("moreOpen", { count: more })}
              </button>
            ) : null}
            <Link href={`/pipeline?deal=${latest.id}`} className="min-h-11 py-2 font-bold underline-offset-4 hover:underline sm:min-h-0 sm:py-0">
              {t("onBoard")}
            </Link>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-muted-foreground">
            {canOpen ? tLead("dealsEmpty") : lead.lead_status === "do_not_contact" ? t("dnc") : ownerName ? t("cannotOpen", { owner: ownerName }) : t("cannotOpenUnowned")}
          </p>
          {canOpen ? (
            <Button variant="quiet" className="min-h-11 sm:min-h-9" onClick={onNewDeal}>
              <Plus aria-hidden="true" strokeWidth={2} className="size-4" />
              {t("open")}
            </Button>
          ) : null}
        </div>
      )}
    </Card>
  );
}
