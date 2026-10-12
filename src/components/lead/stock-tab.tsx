"use client";

import { useState } from "react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { extendHold, setRequestStatus } from "@/app/(app)/inventory/sales/actions";
import { useQtyText } from "@/components/inventory/bits";
import { useStockErrorText } from "@/components/inventory/stock-actions";
import { ListState } from "@/components/inventory/tab-lists";
import { useReleaseHold } from "@/components/inventory/use-hold-actions";
import { fetchProductDetail } from "@/components/inventory/use-inventory";
import { RequestStatusBadge, SaleTypeBadge, lineTone, useRequestLineText } from "@/components/sales/bits";
import { HoldSheet, LogRequestSheet } from "@/components/sales/hold-and-request-sheets";
import { RecordSaleSheet, type SalePrefill } from "@/components/sales/record-sale-sheet";
import { refreshSales, useLeadStock } from "@/components/sales/use-sales";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { extendedUntil } from "@/lib/sales/dates";
import type { LeadHold, LeadStock, StockRequest } from "@/lib/sales/types";
import { cn } from "@/lib/utils";

type Role = "admin" | "manager" | "rep";

// The lead's Stock tab (design 10.4): the actions row (Record sale is the neutral primary here, Call stays the red one),
// Wants (open requests first, each line with live availability), Reserved (active holds: Sell, Extend, Release) and
// Bought (the latest sales and the total). A lead the person cannot change shows the lists without the actions.
export function LeadStockTab({ lead, me, role, active }: { lead: { id: string; name: string }; me: string; role: Role; active: boolean }) {
  const t = useTranslations("Sales.tab");
  const query = useLeadStock(active ? lead.id : null);
  const [sale, setSale] = useState<{ open: boolean; prefill: SalePrefill | null }>({ open: false, prefill: null });
  const [holdOpen, setHoldOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const data = query.data;

  if (!data) {
    if (query.isError) return <ListState kind="error" title={t("error")} onRetry={() => void query.refetch()} />;
    return <StockTabSkeleton />;
  }
  const canEdit = data.can_edit;
  return (
    <div className="flex min-w-0 flex-col gap-6">
      {canEdit ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="neutral" onClick={() => setSale({ open: true, prefill: null })}>
            {t("recordSale")}
          </Button>
          <Button variant="quiet" onClick={() => setHoldOpen(true)}>
            {t("holdStock")}
          </Button>
          <Button variant="quiet" onClick={() => setRequestOpen(true)}>
            {t("logRequest")}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{data.owner_first_name ? t("readOnly", { owner: data.owner_first_name }) : t("readOnlyUnowned")}</p>
      )}

      <Wants data={data} canEdit={canEdit} onSell={(prefill) => setSale({ open: true, prefill })} />
      <Reserved data={data} canEdit={canEdit} me={me} leadId={lead.id} onSell={(prefill) => setSale({ open: true, prefill })} />
      <Bought data={data} leadId={lead.id} />

      {canEdit ? (
        <>
          <RecordSaleSheet
            open={sale.open}
            onOpenChange={(open) => setSale((s) => ({ ...s, open }))}
            lead={lead}
            prefill={sale.prefill}
            canSellBelowMin={role !== "rep"}
          />
          <HoldSheet open={holdOpen} onOpenChange={setHoldOpen} lead={lead} deals={data.deals} />
          <LogRequestSheet open={requestOpen} onOpenChange={setRequestOpen} lead={lead} />
        </>
      ) : null}
    </div>
  );
}

function Section({ id, title, count, children }: { id: string; title: string; count?: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-3">
      <h2 id={id} className="flex items-baseline gap-2 text-lg font-bold">
        {title}
        {count ? <span className="font-mono text-sm font-normal text-muted-foreground">{count}</span> : null}
      </h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg bg-card p-4 text-sm text-muted-foreground">{children}</p>;
}

/** Product details for a sale's lines (live availability and prices), fetched when the person taps Sell. */
async function saleLines(items: { product_id: string; pieces: number }[]) {
  const details = await Promise.all(items.map((i) => fetchProductDetail(i.product_id).catch(() => null)));
  return items.flatMap((i, n) => {
    const d = details[n];
    return d && !d.archived ? [{ product: d, pieces: i.pieces }] : [];
  });
}

function Wants({ data, canEdit, onSell }: { data: LeadStock; canEdit: boolean; onSell: (p: SalePrefill) => void }) {
  const t = useTranslations("Sales.tab");
  const ts = useTranslations("Sales.source");
  const format = useFormatter();
  const lineText = useRequestLineText();
  const errorText = useStockErrorText();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const open = data.requests.filter((r) => r.status === "new" || r.status === "in_progress");
  const setStatus = async (r: StockRequest, status: "done" | "declined") => {
    if (busy) return;
    setBusy(r.id);
    const res = await setRequestStatus({ requestId: r.id, status, teamNote: null }).catch(() => null);
    setBusy(null);
    refreshSales(queryClient, data.company_id);
    toast.show(res?.ok ? t(status === "done" ? "markedDone" : "declined") : errorText(res ?? { ok: false, error: "unavailable" }));
  };
  const sell = async (r: StockRequest) => {
    if (busy) return;
    setBusy(r.id);
    const lines = await saleLines(r.lines.filter((l) => l.product_id).map((l) => ({ product_id: l.product_id as string, pieces: l.pieces })));
    setBusy(null);
    onSell({ lines, stockRequestId: r.id });
  };
  return (
    <Section id={`wants-${data.company_id}`} title={t("wants")} count={open.length ? format.number(open.length) : undefined}>
      {data.requests.length === 0 ? (
        <Empty>{t("wantsEmpty")}</Empty>
      ) : (
        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg bg-card">
          {data.requests.map((r) => {
            const isOpen = r.status === "new" || r.status === "in_progress";
            return (
              <li key={r.id} className={cn("flex flex-col gap-2 p-4", !isOpen && "text-muted-foreground")}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <RequestStatusBadge status={r.status} />
                  <span>{ts(r.source)}</span>
                  <span>· {format.relativeTime(new Date(r.created_at))}</span>
                  {r.requester_name ? (
                    <span dir="auto" translate="no">
                      · {r.requester_name}
                    </span>
                  ) : null}
                </div>
                {r.note ? (
                  <p dir="auto" className="max-w-[65ch] text-sm break-words whitespace-pre-line text-foreground">
                    {r.note}
                  </p>
                ) : null}
                <ul className="flex flex-col gap-1.5">
                  {r.lines.map((l) => {
                    const tone = lineTone(l);
                    return (
                      <li key={l.position} className="flex min-w-0 items-start gap-2 text-sm">
                        <span
                          aria-hidden="true"
                          className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", tone === "green" ? "bg-status-green" : tone === "amber" ? "bg-status-amber" : "bg-muted-foreground/40")}
                        />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate font-bold text-foreground" dir="auto" translate="no">
                            {l.product_name}
                          </span>
                          <span className="font-mono text-xs text-muted-foreground">{lineText(l)}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
                {canEdit && isOpen ? (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {r.lines.some((l) => l.product_id) ? (
                      <Button variant="quiet" className="min-h-11 px-3 text-sm sm:min-h-9" aria-disabled={busy === r.id || undefined} onClick={() => void sell(r)}>
                        {t("recordSale")}
                      </Button>
                    ) : null}
                    <Button variant="quiet" className="min-h-11 px-3 text-sm sm:min-h-9" aria-disabled={busy === r.id || undefined} onClick={() => void setStatus(r, "done")}>
                      {t("markDone")}
                    </Button>
                    <Button variant="quiet" className="min-h-11 px-3 text-sm sm:min-h-9" aria-disabled={busy === r.id || undefined} onClick={() => void setStatus(r, "declined")}>
                      {t("decline")}
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function Reserved({ data, canEdit, me, leadId, onSell }: { data: LeadStock; canEdit: boolean; me: string; leadId: string; onSell: (p: SalePrefill) => void }) {
  const t = useTranslations("Sales.tab");
  const tPlace = useTranslations("Inventory.place");
  const format = useFormatter();
  const qty = useQtyText();
  const release = useReleaseHold();
  const errorText = useStockErrorText();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const day = (iso: string) => format.dateTime(new Date(`${iso}T12:00:00Z`), { day: "numeric", month: "short", timeZone: "UTC" });
  const total = data.holds.reduce((n, h) => n + h.remaining, 0);
  const run = async (h: LeadHold, what: "release" | "extend" | "sell") => {
    if (busy) return;
    setBusy(h.id);
    if (what === "release") {
      await release({ ...h, company_id: leadId, note: null }, h.product_id);
      refreshSales(queryClient, leadId);
    } else if (what === "extend") {
      const res = await extendHold({ reservationId: h.id, holdUntil: extendedUntil(h.hold_until) }).catch(() => null);
      refreshSales(queryClient, leadId);
      toast.show(res?.ok ? t("extended", { date: day(res.data.hold_until) }) : errorText(res ?? { ok: false, error: "unavailable" }));
    } else {
      const lines = await saleLines([{ product_id: h.product_id, pieces: h.remaining }]);
      onSell({ lines, dealId: h.deal_id });
    }
    setBusy(null);
  };
  return (
    <Section id={`reserved-${leadId}`} title={t("reserved")} count={total ? t("piecesCount", { count: total }) : undefined}>
      {data.holds.length === 0 ? (
        <Empty>{t("reservedEmpty")}</Empty>
      ) : (
        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg bg-card">
          {data.holds.map((h) => {
            const mine = canEdit || h.created_by === me;
            return (
              <li key={h.id} className="flex flex-wrap items-center gap-3 p-3 sm:px-4">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate font-bold" dir="auto" translate="no">
                    {h.product_name}
                  </span>
                  <span className="flex flex-wrap gap-x-1.5 text-xs text-muted-foreground">
                    <span>{tPlace(h.location)}</span>
                    <span>·</span>
                    {h.ended ? <span className="text-status-amber">{t("holdEnded")}</span> : <span>{t("until", { date: day(h.hold_until) })}</span>}
                    {h.deal_id ? <span>· {t("deal")}</span> : null}
                  </span>
                </span>
                <span className="shrink-0 font-mono">{qty(h.remaining, h.pieces_per_carton)}</span>
                {mine ? (
                  <span className="flex w-full flex-wrap gap-2 sm:w-auto">
                    {canEdit && h.location === "warehouse" ? (
                      <Button variant="quiet" className="min-h-11 px-3 text-sm sm:min-h-9" aria-disabled={busy === h.id || undefined} aria-label={t("sellOf", { product: h.product_name })} onClick={() => void run(h, "sell")}>
                        {t("sell")}
                      </Button>
                    ) : null}
                    <Button variant="quiet" className="min-h-11 px-3 text-sm sm:min-h-9" aria-disabled={busy === h.id || undefined} aria-label={t("extendOf", { product: h.product_name })} onClick={() => void run(h, "extend")}>
                      {t("extend")}
                    </Button>
                    <Button variant="quiet" className="min-h-11 px-3 text-sm sm:min-h-9" aria-disabled={busy === h.id || undefined} aria-label={t("releaseOf", { product: h.product_name })} onClick={() => void run(h, "release")}>
                      {t("release")}
                    </Button>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function Bought({ data, leadId }: { data: LeadStock; leadId: string }) {
  const t = useTranslations("Sales.tab");
  const format = useFormatter();
  const eur = (n: number) => format.number(Number(n), { style: "currency", currency: "EUR" });
  return (
    <Section id={`bought-${leadId}`} title={t("bought")}>
      {data.sales.length === 0 ? (
        <Empty>{t("boughtEmpty")}</Empty>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{t("boughtTotal", { total: eur(data.bought_total), count: data.sales_count })}</p>
          <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg bg-card">
            {data.sales.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3 sm:px-4">
                <span className="flex min-w-0 basis-full flex-col gap-0.5 sm:basis-auto sm:flex-1">
                  <span className={cn("flex min-w-0 items-center gap-2", s.status === "cancelled" && "text-muted-foreground line-through")}>
                    <span className="shrink-0 font-mono text-sm whitespace-nowrap">{t("number", { number: s.number })}</span>
                    <span className="truncate text-sm" dir="auto">
                      {s.items ?? ""}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                    <span>{format.dateTime(new Date(s.created_at), { day: "numeric", month: "short", year: "numeric" })}</span>
                    {s.created_by_first_name ? <span>· {t("by", { name: s.created_by_first_name })}</span> : null}
                    {s.status === "cancelled" ? <span>· {t("cancelled")}</span> : null}
                  </span>
                </span>
                <SaleTypeBadge fulfilment={s.fulfilment} />
                <span className={cn("ms-auto shrink-0 font-mono sm:ms-0", s.status === "cancelled" && "text-muted-foreground line-through")}>{eur(s.total)}</span>
              </li>
            ))}
          </ul>
          {data.sales_count > data.sales.length ? (
            <Link href={`/inventory?tab=sales&company=${leadId}`} className="inline-flex min-h-11 items-center self-start text-sm font-bold underline-offset-4 hover:underline">
              {t("showAll")}
            </Link>
          ) : null}
        </>
      )}
    </Section>
  );
}

function StockTabSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-6">
      <div className="flex gap-2">
        <div className="h-11 w-32 rounded-md bg-muted motion-safe:animate-pulse" />
        <div className="h-11 w-28 rounded-md bg-muted motion-safe:animate-pulse" />
        <div className="h-11 w-32 rounded-md bg-muted motion-safe:animate-pulse" />
      </div>
      {[3, 2, 3].map((rows, i) => (
        <div key={i} className="flex flex-col gap-3">
          <div className="h-6 w-24 rounded-sm bg-muted motion-safe:animate-pulse" />
          <div className="flex flex-col overflow-hidden rounded-lg bg-card">
            {Array.from({ length: rows }, (_, j) => (
              <div key={j} className="flex h-[64px] items-center gap-4 border-b border-border px-4">
                <div className="flex flex-1 flex-col gap-2">
                  <div className="h-4 w-1/3 rounded-sm bg-muted motion-safe:animate-pulse" />
                  <div className="h-3 w-1/4 rounded-sm bg-muted motion-safe:animate-pulse" />
                </div>
                <div className="h-5 w-16 rounded-sm bg-muted motion-safe:animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
