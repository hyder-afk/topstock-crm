"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { MoreHorizontal, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Card } from "@/components/lead/lead-cards";
import { elapsedDays, reopenOffered, type DealCard, type DealDetail, type StageKey } from "@/lib/deals";
import { personName, type LeadDetail } from "@/lib/leads";
import { formatMoney } from "@/lib/money";
import { dealKey, fetchDealClient, fetchLeadDealsClient, leadDealsKey } from "@/lib/prefetch";
import { cardTitle, retryKeepingFocus } from "@/lib/focus";
import { cn } from "@/lib/utils";

// The lead page's Deals tab (Day 5 design 7.9; replaces Day 4b's "nothing yet"): the lead's deals the viewer sees
// (list_lead_deals), open first, then closed. Rows of 72 px: a mini stepper (4 dots), the title or "Deal", the stage,
// the value, days in stage or Stalled, the expected close, the owner. A row opens the deal sheet over the page
// (?tab=deals&deal=). "Open a deal" for editors; the reason it is missing otherwise. Loading, empty and error states.
const STEPS: StageKey[] = ["lead", "qualified", "negotiations", "won"];

export function useLeadDeals(leadId: string, enabled = true) {
  return useQuery({ queryKey: leadDealsKey(leadId), queryFn: () => fetchLeadDealsClient(leadId), staleTime: 30_000, enabled });
}

export function MiniStepper({ stage }: { stage: StageKey }) {
  const i = STEPS.indexOf(stage);
  return (
    <span aria-hidden="true" className="flex items-center gap-1">
      {STEPS.map((s, n) => (
        <span key={s} className={cn("size-1.5 rounded-full", stage === "lost" ? "bg-border" : n <= i ? "bg-foreground" : "bg-border")} />
      ))}
    </span>
  );
}

export function DealsTab({
  lead,
  onOpenDeal,
  onNewDeal,
  onReopen,
}: {
  lead: LeadDetail;
  onOpenDeal: (id: string) => void;
  onNewDeal: () => void;
  onReopen: (deal: DealCard, done?: (ok: boolean) => void) => void;
}) {
  const t = useTranslations("LeadPage.deals");
  const tLead = useTranslations("LeadPage");
  const tLeads = useTranslations("Leads");
  const q = useLeadDeals(lead.id);
  const ownerName = lead.owner ? personName(lead.owner) || tLeads("noName") : null;
  const canOpen = lead.can_open_deal ?? lead.can_edit;
  const deals = q.data ?? [];
  const open = deals.filter((d) => d.status === "open");
  const closed = deals.filter((d) => d.status !== "open");
  // A reopened deal moves from Closed to Open, and its row menu goes with the closed row: once the list shows it open,
  // its row takes the focus (in a layout effect, so the focus never rests on <body> in between).
  const reopened = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = reopened.current;
    if (!id || !q.data?.some((d) => d.id === id && d.status === "open")) return;
    reopened.current = null;
    document.querySelector<HTMLElement>(`[data-deal-row="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  }, [q.data]);
  const reopen = (deal: DealCard) => {
    reopened.current = deal.id;
    onReopen(deal, (ok) => {
      if (!ok && reopened.current === deal.id) reopened.current = null;
    });
  };

  const action = canOpen ? (
    <Button variant="neutral" className="min-h-11 max-sm:w-full sm:min-h-9" onClick={onNewDeal}>
      <Plus aria-hidden="true" strokeWidth={2} className="size-4" />
      {t("open")}
    </Button>
  ) : null;
  const cannot =
    lead.lead_status === "do_not_contact" ? t("dnc") : !lead.can_edit ? (ownerName ? t("cannotOpen", { owner: ownerName }) : t("cannotOpenUnowned")) : null;

  return (
    <Card title={tLead("tabs.deals")} action={<span className="max-sm:hidden">{action}</span>} focusableTitle>
      <div className="sm:hidden">{action}</div>
      {q.isPending ? (
        <ul aria-busy="true" className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <li key={i} className="h-[72px] rounded-md bg-muted motion-safe:animate-pulse" />
          ))}
        </ul>
      ) : q.isError ? (
        <div role="alert" className="flex flex-col items-start gap-2">
          <p className="text-sm font-bold">{t("loadFailed")}</p>
          <Button variant="quiet" onClick={(e) => void retryKeepingFocus(e.currentTarget, cardTitle, () => q.refetch())}>
            {t("retry")}
          </Button>
        </div>
      ) : deals.length === 0 ? (
        <p className="text-sm text-muted-foreground">{canOpen ? tLead("dealsEmpty") : cannot}</p>
      ) : (
        <>
          {cannot && !canOpen ? <p className="text-sm text-muted-foreground">{cannot}</p> : null}
          {open.length ? <DealRows title={t("openSection")} deals={open} onOpenDeal={onOpenDeal} onReopen={reopen} /> : null}
          {closed.length ? <DealRows title={t("closedSection")} deals={closed} onOpenDeal={onOpenDeal} onReopen={reopen} /> : null}
        </>
      )}
    </Card>
  );
}

function DealRows({ title, deals, onOpenDeal, onReopen }: { title: string; deals: DealCard[]; onOpenDeal: (id: string) => void; onReopen: (d: DealCard) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-xs font-bold text-muted-foreground">{title}</h3>
      <ul className="flex flex-col divide-y divide-border">
        {deals.map((d) => (
          <DealRow key={d.id} deal={d} onOpenDeal={onOpenDeal} onReopen={onReopen} />
        ))}
      </ul>
    </div>
  );
}

function DealRow({ deal, onOpenDeal, onReopen }: { deal: DealCard; onOpenDeal: (id: string) => void; onReopen: (d: DealCard) => void }) {
  const t = useTranslations("LeadPage.deals");
  const tD = useTranslations("Deals");
  const tStage = useTranslations("Stages");
  const tR = useTranslations("LostReasons");
  const tF = useTranslations("Fulfilment");
  const locale = useLocale();
  const format = useFormatter();
  const [now] = useState(() => Date.now());
  // The deal's details when the sheet has loaded them (read from the cache, never fetched here): a won deal that stock
  // records hold cannot be reopened, so its row has no menu (Day 7; the database still refuses it).
  const detail = useQuery<DealDetail | null>({ queryKey: dealKey(deal.id), queryFn: () => fetchDealClient(deal.id), enabled: false }).data;
  const date = (iso: string) => format.dateTime(new Date(iso), { day: "numeric", month: "short" });
  const owner = personName({ first_name: deal.owner_first_name, last_name: deal.owner_last_name });
  let line: string;
  if (deal.status === "won" && deal.closed_at) {
    line = deal.value ? t("closedWon", { value: formatMoney(deal.value, locale), date: date(deal.closed_at) }) : t("closedWonNoValue", { date: date(deal.closed_at) });
    if (deal.fulfilment) line += ` · ${tF(`${deal.fulfilment}.title`)}`;
  } else if (deal.status === "lost" && deal.closed_at) {
    line = t("closedLost", { reason: deal.lost_reason ? tR(deal.lost_reason) : "", date: date(deal.closed_at) });
  } else {
    line = [tStage(deal.stage), deal.value ? formatMoney(deal.value, locale) : tD("addValue"), deal.is_stalled ? tD("stalled") : tD("daysInStage", { count: elapsedDays(deal.stage_entered_at, now) })].join(" · ");
  }
  return (
    <li className="flex min-h-[72px] items-center gap-2">
      <button
        type="button"
        data-deal-row={deal.id}
        onClick={() => onOpenDeal(deal.id)}
        className="flex min-h-[72px] min-w-0 flex-1 flex-col items-start justify-center gap-1 rounded-md px-1 text-left transition-colors hover:bg-muted/60"
      >
        <span className="flex w-full items-center gap-2">
          <MiniStepper stage={deal.stage} />
          <span className="min-w-0 truncate text-sm font-bold">{deal.title ?? tD("untitled")}</span>
        </span>
        <span className="flex w-full flex-wrap gap-x-2 text-xs text-muted-foreground">
          <span className={cn(deal.status === "open" && deal.value && "font-mono")}>{line}</span>
          {deal.status === "open" && deal.expected_close ? (
            <span>{tD("closes", { date: format.dateTime(new Date(`${deal.expected_close}T12:00:00Z`), { day: "numeric", month: "short", timeZone: "UTC" }) })}</span>
          ) : null}
          {owner ? <span>{owner}</span> : null}
        </span>
      </button>
      {reopenOffered({ ...deal, held: detail?.stock_held }) ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t("rowMenu")}
            className="grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground transition-[color,scale] duration-150 hover:text-foreground active:scale-[0.97]"
          >
            <MoreHorizontal aria-hidden="true" strokeWidth={1.75} className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={() => onReopen(deal)}>{t("reopen")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </li>
  );
}
