"use client";

import { useId, useMemo, useState } from "react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, X } from "lucide-react";
import { cancelSale, setRequestStatus, undoSale } from "@/app/(app)/inventory/sales/actions";
import { runWithStepUp, useStockErrorText, type StepUp } from "@/components/inventory/stock-actions";
import { ListState, RowsSkeleton } from "@/components/inventory/tab-lists";
import { fetchProductDetail } from "@/components/inventory/use-inventory";
import { RequestStatusBadge, SaleTypeBadge, lineTone, useRequestLineText } from "@/components/sales/bits";
import type { SaleLead, SalePrefill } from "@/components/sales/record-sale-sheet";
import { refreshSales, useRequest, useRequests, useSale, useSales } from "@/components/sales/use-sales";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, phoneSheet } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import type { Fulfilment, RequestRow, SaleRow } from "@/lib/sales/types";
import { cn } from "@/lib/utils";

function Chips<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex snap-x gap-2 overflow-x-auto overscroll-x-contain pb-1">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            "min-h-11 shrink-0 snap-start rounded-full px-4 text-sm whitespace-nowrap transition-[background-color,transform] duration-150 active:scale-[0.97] sm:min-h-9",
            value === o.id ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function MoreButton({ has, busy, onMore, label }: { has: boolean; busy: boolean; onMore: () => void; label: string }) {
  if (!has) return null;
  return (
    <Button variant="quiet" className="self-start" aria-disabled={busy || undefined} onClick={() => !busy && onMore()}>
      {label}
    </Button>
  );
}

// Sales (design 10.1): number, date, lead, type, items, total, by, status (Cancelled struck through). Filters: type and
// the lead from the URL (the lead's "Show all"). A row opens its detail: lines, price per piece, below-minimum flags,
// Undo within 2 minutes (the seller) or Cancel (managers and admins, with a fresh code and a reason).
export function SalesList({
  canManage,
  stepUp,
  company,
  onClearCompany,
}: {
  canManage: boolean;
  stepUp: StepUp;
  company: string | null;
  onClearCompany: () => void;
}) {
  const t = useTranslations("Sales.list");
  const tf = useTranslations("Sales.fulfilment");
  const ti = useTranslations("Inventory");
  const [type, setType] = useState<"all" | Fulfilment>("all");
  const query = useSales({ company: company ?? undefined, fulfilment: type === "all" ? undefined : type });
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.rows) ?? [], [query.data]);
  const [openId, setOpenId] = useState<string | null>(null);
  const companyName = company ? (rows[0]?.company_name ?? null) : null;
  const filtered = type !== "all" || !!company;
  let body: React.ReactNode;
  if (query.isPending) body = <RowsSkeleton rows={6} />;
  else if (query.isError && rows.length === 0) body = <ListState kind="error" title={t("error")} onRetry={() => void query.refetch()} />;
  else if (rows.length === 0) body = <ListState kind="empty" title={filtered ? t("noMatch") : t("emptyTitle")} body={filtered ? undefined : t("emptyBody")} />;
  else
    body = (
      <div className="flex flex-col gap-3">
        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg bg-card">
          {rows.map((s) => (
            <SaleItem key={s.id} sale={s} open={openId === s.id} onToggle={() => setOpenId((o) => (o === s.id ? null : s.id))} canManage={canManage} stepUp={stepUp} />
          ))}
        </ul>
        <MoreButton has={!!query.hasNextPage} busy={query.isFetchingNextPage} onMore={() => void query.fetchNextPage()} label={ti("showMore")} />
      </div>
    );
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Chips
          label={t("typeFilter")}
          value={type}
          onChange={setType}
          options={[
            { id: "all", label: t("all") },
            { id: "from_stock", label: tf("from_stock") },
            { id: "direct_from_source", label: tf("direct_from_source") },
          ]}
        />
        {company ? (
          <button
            type="button"
            onClick={onClearCompany}
            aria-label={t("clearLead", { lead: companyName ?? "" })}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-muted px-4 text-sm sm:min-h-9"
          >
            <span className="max-w-[24ch] truncate" dir="auto" translate="no">
              {companyName ?? t("oneLead")}
            </span>
            <X aria-hidden="true" strokeWidth={1.75} className="size-4" />
          </button>
        ) : null}
      </div>
      {body}
    </div>
  );
}

function SaleItem({ sale, open, onToggle, canManage, stepUp }: { sale: SaleRow; open: boolean; onToggle: () => void; canManage: boolean; stepUp: StepUp }) {
  const t = useTranslations("Sales.list");
  const format = useFormatter();
  const id = useId();
  const cancelled = sale.status === "cancelled";
  return (
    <li className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-detail`}
        onClick={onToggle}
        className="flex min-h-[64px] w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 p-3 text-left hover:bg-muted/50 sm:flex-nowrap sm:px-4"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={cn("flex min-w-0 items-center gap-2", cancelled && "text-muted-foreground line-through")}>
            <span className="shrink-0 font-mono text-sm">{t("number", { number: sale.number })}</span>
            <span className="truncate font-bold" dir="auto" translate="no">
              {sale.company_name}
            </span>
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span className="max-w-full truncate" dir="auto">
              {sale.items ?? ""}
            </span>
            <span>· {format.dateTime(new Date(sale.created_at), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
            {sale.created_by_first_name ? <span>· {t("by", { name: sale.created_by_first_name })}</span> : null}
            {sale.deal_id ? <span>· {t("deal")}</span> : null}
            {cancelled ? <span>· {t("cancelled")}</span> : null}
          </span>
        </span>
        <SaleTypeBadge fulfilment={sale.fulfilment} />
        <span className={cn("shrink-0 font-mono", cancelled && "text-muted-foreground line-through")}>{format.number(Number(sale.total), { style: "currency", currency: "EUR" })}</span>
        <ChevronDown aria-hidden="true" strokeWidth={1.75} className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-200", open && "rotate-180")} />
      </button>
      {open ? (
        <div id={`${id}-detail`} className="border-t border-border bg-background/40 p-3 sm:px-4">
          <SaleDetailView id={sale.id} companyId={sale.company_id} canManage={canManage} stepUp={stepUp} />
        </div>
      ) : null}
    </li>
  );
}

function SaleDetailView({ id, companyId, canManage, stepUp }: { id: string; companyId: string; canManage: boolean; stepUp: StepUp }) {
  const t = useTranslations("Sales.list");
  const format = useFormatter();
  const query = useSale(id);
  const errorText = useStockErrorText();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const eur = (n: number | string) => format.number(Number(n), { style: "currency", currency: "EUR" });
  const s = query.data;
  if (!s) {
    if (query.isError) return <ListState kind="error" title={t("detailError")} onRetry={() => void query.refetch()} />;
    return (
      <div aria-hidden="true" className="flex flex-col gap-2">
        <div className="h-4 w-1/2 rounded-sm bg-muted motion-safe:animate-pulse" />
        <div className="h-4 w-1/3 rounded-sm bg-muted motion-safe:animate-pulse" />
      </div>
    );
  }
  const showCost = s.lines.some((l) => l.cost_per_piece !== null);
  const undo = async () => {
    if (busy) return;
    setBusy(true);
    const res = await undoSale(s.id).catch(() => null);
    setBusy(false);
    refreshSales(queryClient, companyId);
    toast.show(res?.ok ? t("undone", { number: s.number }) : errorText(res ?? { ok: false, error: "unavailable" }));
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-sm">
          <caption className="sr-only">{t("linesCaption", { number: s.number })}</caption>
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th scope="col" className="py-1 pr-3 font-normal">
                {t("product")}
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-normal">
                {t("pieces")}
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-normal">
                {t("pricePc")}
              </th>
              {showCost ? (
                <th scope="col" className="py-1 pr-3 text-right font-normal">
                  {t("costPc")}
                </th>
              ) : null}
              <th scope="col" className="py-1 text-right font-normal">
                {t("lineTotal")}
              </th>
            </tr>
          </thead>
          <tbody>
            {s.lines.map((l) => (
              <tr key={l.position} className="border-t border-border">
                <td className="py-2 pr-3">
                  <span className="block truncate" dir="auto" translate="no">
                    {l.product_name}
                  </span>
                  {l.below_min ? (
                    <span className="flex items-center gap-1.5 text-xs text-status-amber">
                      <span aria-hidden="true" className="size-1.5 rounded-full bg-status-amber" />
                      {t("belowMin")}
                    </span>
                  ) : null}
                </td>
                <td className="py-2 pr-3 text-right font-mono tabular-nums">{format.number(Number(l.quantity))}</td>
                <td className="py-2 pr-3 text-right font-mono tabular-nums">{eur(l.unit_price)}</td>
                {showCost ? <td className="py-2 pr-3 text-right font-mono text-muted-foreground tabular-nums">{l.cost_per_piece === null ? "–" : eur(l.cost_per_piece)}</td> : null}
                <td className="py-2 text-right font-mono tabular-nums">{eur(l.line_total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {s.ship_to_country ? <p className="text-sm text-muted-foreground">{t("shipTo", { country: s.ship_to_country })}</p> : null}
      {s.note ? (
        <p dir="auto" className="max-w-[65ch] text-sm break-words whitespace-pre-line">
          {s.note}
        </p>
      ) : null}
      {s.status === "cancelled" && s.cancel_reason ? (
        <p className="text-sm text-muted-foreground" dir="auto">
          {t("cancelledBecause", { reason: s.cancel_reason })}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/leads/${s.company_id}?tab=stock`} className="inline-flex min-h-11 items-center px-1 text-sm font-bold underline-offset-4 hover:underline sm:min-h-9">
          {t("openLead")}
        </Link>
        {s.can_undo ? (
          <Button variant="quiet" className="min-h-11 px-3 text-sm sm:min-h-9" aria-disabled={busy || undefined} onClick={() => void undo()}>
            {t("undo")}
          </Button>
        ) : null}
        {canManage && s.status === "confirmed" && !s.can_undo ? (
          <Button variant="quiet" className="min-h-11 px-3 text-sm sm:min-h-9" onClick={() => setCancelOpen(true)}>
            {t("cancel")}
          </Button>
        ) : null}
      </div>
      <CancelSaleDialog open={cancelOpen} onOpenChange={setCancelOpen} orderId={s.id} number={s.number} companyId={companyId} stepUp={stepUp} />
    </div>
  );
}

function CancelSaleDialog({
  open,
  onOpenChange,
  orderId,
  number,
  companyId,
  stepUp,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  orderId: string;
  number: number;
  companyId: string;
  stepUp: StepUp;
}) {
  const t = useTranslations("Sales.cancel");
  const errorText = useStockErrorText();
  const toast = useToast();
  const queryClient = useQueryClient();
  const formId = useId();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [was, setWas] = useState(false);
  if (open !== was) {
    setWas(open);
    if (open) {
      setReason("");
      setError(null);
    }
  }
  const why = reason.trim().length < 3 ? t("needReason") : null;
  const submit = async () => {
    if (why || busy) return;
    setBusy(true);
    const res = await runWithStepUp(stepUp, () => cancelSale({ orderId, reason: reason.trim() }));
    setBusy(false);
    if (!res) return;
    refreshSales(queryClient, companyId);
    if (!res.ok) {
      setError(errorText(res));
      return;
    }
    onOpenChange(false);
    toast.show(t("done", { number }));
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className={cn(phoneSheet, "sm:max-w-md")}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1">
            <DialogTitle className="text-xl font-bold">{t("title", { number })}</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">{t("body")}</DialogDescription>
          </div>
          <label htmlFor={`${formId}-reason`} className="text-sm font-bold">
            {t("reason")}
          </label>
          <textarea
            id={`${formId}-reason`}
            name="reason"
            rows={3}
            maxLength={300}
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-describedby={`${formId}-why`}
            className="rounded-md border border-border bg-background px-3 py-2 text-base"
          />
          <div className="flex flex-col gap-1">
            <Button type="submit" variant="neutral" aria-disabled={!!why || busy || undefined} aria-describedby={`${formId}-why`}>
              {busy ? t("cancelling") : t("confirm")}
            </Button>
            <p id={`${formId}-why`} role={error ? "alert" : undefined} className="min-h-5 text-xs text-muted-foreground" aria-live="polite">
              {error ?? why ?? ""}
            </p>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Requests (design 10.1 and 6.8): Open (new and in progress), Done, Declined, All. A row opens the lines with live
// availability now and the actions: Record sale (prefilled), In progress, Done, Decline.
export function RequestsList({ onRecordSale }: { onRecordSale: (lead: SaleLead, prefill: SalePrefill) => void }) {
  const t = useTranslations("Sales.requests");
  const ti = useTranslations("Inventory");
  const [status, setStatus] = useState<"open" | "done" | "declined" | "all">("open");
  const query = useRequests(status);
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.rows) ?? [], [query.data]);
  const [openId, setOpenId] = useState<string | null>(null);
  let body: React.ReactNode;
  if (query.isPending) body = <RowsSkeleton rows={5} />;
  else if (query.isError && rows.length === 0) body = <ListState kind="error" title={t("error")} onRetry={() => void query.refetch()} />;
  else if (rows.length === 0) body = <ListState kind="empty" title={status === "open" ? t("emptyTitle") : t("noMatch")} body={status === "open" ? t("emptyBody") : undefined} />;
  else
    body = (
      <div className="flex flex-col gap-3">
        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg bg-card">
          {rows.map((r) => (
            <RequestItem key={r.id} row={r} open={openId === r.id} onToggle={() => setOpenId((o) => (o === r.id ? null : r.id))} onRecordSale={onRecordSale} />
          ))}
        </ul>
        <MoreButton has={!!query.hasNextPage} busy={query.isFetchingNextPage} onMore={() => void query.fetchNextPage()} label={ti("showMore")} />
      </div>
    );
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Chips
        label={t("statusFilter")}
        value={status}
        onChange={setStatus}
        options={[
          { id: "open", label: t("open") },
          { id: "done", label: t("done") },
          { id: "declined", label: t("declined") },
          { id: "all", label: t("all") },
        ]}
      />
      {body}
    </div>
  );
}

function RequestItem({ row, open, onToggle, onRecordSale }: { row: RequestRow; open: boolean; onToggle: () => void; onRecordSale: (lead: SaleLead, prefill: SalePrefill) => void }) {
  const t = useTranslations("Sales.requests");
  const ts = useTranslations("Sales.source");
  const format = useFormatter();
  const id = useId();
  return (
    <li className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-detail`}
        onClick={onToggle}
        className="flex min-h-[64px] w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 p-3 text-left hover:bg-muted/50 sm:flex-nowrap sm:px-4"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate font-bold" dir="auto" translate="no">
            {row.company_name}
          </span>
          <span className="truncate text-xs text-muted-foreground" dir="auto">
            {t("summary", { count: row.line_count })}
            {row.items ? ` · ${row.items}` : ""}
            {row.note ? ` · ${t("quoted", { note: row.note })}` : ""}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <span>{ts(row.source)}</span>
          <span>{format.relativeTime(new Date(row.created_at))}</span>
          <RequestStatusBadge status={row.status} />
        </span>
        <ChevronDown aria-hidden="true" strokeWidth={1.75} className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-200", open && "rotate-180")} />
      </button>
      {open ? (
        <div id={`${id}-detail`} className="border-t border-border bg-background/40 p-3 sm:px-4">
          <RequestDetailView id={row.id} onRecordSale={onRecordSale} />
        </div>
      ) : null}
    </li>
  );
}

function RequestDetailView({ id, onRecordSale }: { id: string; onRecordSale: (lead: SaleLead, prefill: SalePrefill) => void }) {
  const t = useTranslations("Sales.requests");
  const query = useRequest(id);
  const lineText = useRequestLineText();
  const errorText = useStockErrorText();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const r = query.data;
  if (!r) {
    if (query.isError) return <ListState kind="error" title={t("detailError")} onRetry={() => void query.refetch()} />;
    return (
      <div aria-hidden="true" className="flex flex-col gap-2">
        <div className="h-4 w-1/2 rounded-sm bg-muted motion-safe:animate-pulse" />
        <div className="h-4 w-1/3 rounded-sm bg-muted motion-safe:animate-pulse" />
      </div>
    );
  }
  const isOpen = r.status === "new" || r.status === "in_progress";
  const set = async (status: "in_progress" | "done" | "declined") => {
    if (busy) return;
    setBusy(true);
    const res = await setRequestStatus({ requestId: r.id, status, teamNote: null }).catch(() => null);
    setBusy(false);
    refreshSales(queryClient, r.company_id);
    toast.show(res?.ok ? t(`set.${status}`) : errorText(res ?? { ok: false, error: "unavailable" }));
  };
  const sell = async () => {
    if (busy) return;
    setBusy(true);
    const items = r.lines.filter((l) => l.product_id);
    const details = await Promise.all(items.map((l) => fetchProductDetail(l.product_id as string).catch(() => null)));
    setBusy(false);
    onRecordSale(
      { id: r.company_id, name: r.company_name },
      { stockRequestId: r.id, lines: items.flatMap((l, i) => (details[i] && !details[i].archived ? [{ product: details[i], pieces: l.pieces }] : [])) },
    );
  };
  return (
    <div className="flex flex-col gap-3">
      {r.note ? (
        <p dir="auto" className="max-w-[65ch] text-sm break-words whitespace-pre-line">
          {r.note}
        </p>
      ) : null}
      <ul className="flex flex-col gap-1.5">
        {r.lines.map((l) => {
          const tone = lineTone(l);
          return (
            <li key={l.position} className="flex min-w-0 items-start gap-2 text-sm">
              <span aria-hidden="true" className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", tone === "green" ? "bg-status-green" : tone === "amber" ? "bg-status-amber" : "bg-muted-foreground/40")} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-bold" dir="auto" translate="no">
                  {l.product_name}
                </span>
                <span className="font-mono text-xs text-muted-foreground">{lineText(l)}</span>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/leads/${r.company_id}?tab=stock`} className="inline-flex min-h-11 items-center px-1 text-sm font-bold underline-offset-4 hover:underline sm:min-h-9">
          {t("openLead")}
        </Link>
        {isOpen && r.lines.some((l) => l.product_id) ? (
          <Button variant="quiet" className="min-h-11 px-3 text-sm sm:min-h-9" aria-disabled={busy || undefined} onClick={() => void sell()}>
            {t("recordSale")}
          </Button>
        ) : null}
        {r.status === "new" ? (
          <Button variant="quiet" className="min-h-11 px-3 text-sm sm:min-h-9" aria-disabled={busy || undefined} onClick={() => void set("in_progress")}>
            {t("markInProgress")}
          </Button>
        ) : null}
        {isOpen ? (
          <>
            <Button variant="quiet" className="min-h-11 px-3 text-sm sm:min-h-9" aria-disabled={busy || undefined} onClick={() => void set("done")}>
              {t("markDone")}
            </Button>
            <Button variant="quiet" className="min-h-11 px-3 text-sm sm:min-h-9" aria-disabled={busy || undefined} onClick={() => void set("declined")}>
              {t("decline")}
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
