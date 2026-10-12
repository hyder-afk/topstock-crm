"use client";

import { useEffect, useEffectEvent, useId, useMemo, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { recordSale, undoSale } from "@/app/(app)/inventory/sales/actions";
import { QuantityField, fieldPieces, useQtyText } from "@/components/inventory/bits";
import { requestId as newRequestId, useStockErrorText } from "@/components/inventory/stock-actions";
import { focusField } from "@/components/sales/bits";
import { LeadPicker, ProductPicker } from "@/components/sales/pickers";
import { refreshSales, useLeadStock } from "@/components/sales/use-sales";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, phoneSheet } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { useToast } from "@/components/ui/toast";
import { parsePrice } from "@/lib/inventory/units";
import type { QtyUnit } from "@/lib/inventory/units";
import type { StockFailure } from "@/lib/inventory/errors";
import type { StockRow } from "@/lib/inventory/types";
import type { Fulfilment } from "@/lib/sales/types";
import { useModKey } from "@/lib/use-platform";
import { cn } from "@/lib/utils";

export type SaleLead = { id: string; name: string };
export type SalePrefill = {
  lines?: { product: Pick<StockRow, "id" | "name" | "pieces_per_carton" | "price_min" | "price_max" | "wh_available">; pieces: number }[];
  stockRequestId?: string | null;
  dealId?: string | null;
};

type Line = {
  key: string;
  product: Pick<StockRow, "id" | "name" | "pieces_per_carton" | "price_min" | "price_max" | "wh_available"> | null;
  description: string;
  qtyText: string;
  unit: QtyUnit;
  priceText: string;
};

const blankLine = (): Line => ({ key: crypto.randomUUID(), product: null, description: "", qtyText: "", unit: "piece", priceText: "" });
const priceText = (n: number | null) => (n === null ? "" : String(Number(n)));

// Record a sale (design 6.1, 6.2 and 10.2): lead, Warehouse inventory or Supplier Stock, lines (product, pieces or
// cartons, price per piece prefilled with the max price, excluding VAT), the deal when the lead has one, the ship-to
// country and a note for Supplier Stock. One database call records the sale and moves the stock; a retry after a lost
// connection reuses the same request id, so it never sells twice. The toast offers Undo for 120 s.
export function RecordSaleSheet({
  open,
  onOpenChange,
  lead,
  prefill,
  canSellBelowMin,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lead: SaleLead | null;
  prefill?: SalePrefill | null;
  canSellBelowMin: boolean;
}) {
  const t = useTranslations("Sales.sheet");
  const tc = useTranslations("Sales");
  const format = useFormatter();
  const qty = useQtyText();
  const modKey = useModKey();
  const errorText = useStockErrorText();
  const toast = useToast();
  const queryClient = useQueryClient();
  const formId = useId();
  const [chosenLead, setChosenLead] = useState<SaleLead | null>(lead);
  const [fulfilment, setFulfilment] = useState<Fulfilment>("from_stock");
  const [lines, setLines] = useState<Line[]>([blankLine()]);
  const [dealId, setDealId] = useState<string | null>(null);
  const [country, setCountry] = useState("");
  const [note, setNote] = useState("");
  const [belowOk, setBelowOk] = useState(false);
  const [reqId, setReqId] = useState(() => newRequestId());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<StockFailure | null>(null);
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  // A fresh form each time the sheet opens (from a lead, a request, a hold or Inventory).
  const key = open
    ? [lead?.id ?? "", prefill?.stockRequestId ?? "", prefill?.dealId ?? "", ...(prefill?.lines ?? []).map((l) => `${l.product.id}:${l.pieces}`)].join("|")
    : null;
  if (open && openedFor !== key) {
    setOpenedFor(key);
    setChosenLead(lead);
    setFulfilment("from_stock");
    setLines(
      prefill?.lines?.length
        ? prefill.lines.map((l) => ({ ...blankLine(), product: l.product, qtyText: l.pieces > 0 ? String(l.pieces) : "", priceText: priceText(l.product.price_max) }))
        : [blankLine()],
    );
    setDealId(prefill?.dealId ?? null);
    setCountry("");
    setNote("");
    setBelowOk(false);
    setReqId(newRequestId());
    setFailure(null);
  }
  if (!open && openedFor !== null) setOpenedFor(null);

  const leadStock = useLeadStock(open ? (chosenLead?.id ?? null) : null);
  const deals = useMemo(
    () => (leadStock.data?.deals ?? []).filter((d) => d.fulfilment === fulfilment || d.id === dealId),
    [leadStock.data, fulfilment, dealId],
  );
  const heldFor = useMemo(() => {
    const m: Record<string, number> = {};
    for (const h of leadStock.data?.holds ?? []) if (h.location === "warehouse") m[h.product_id] = (m[h.product_id] ?? 0) + h.remaining;
    return m;
  }, [leadStock.data]);

  const parsed = lines.map((l) => {
    const ppc = l.product?.pieces_per_carton ?? 1;
    const pieces = fieldPieces(l.qtyText, l.unit, ppc);
    const price = parsePrice(l.priceText);
    const below = fulfilment === "from_stock" && !!l.product && price !== null && l.product.price_min !== null && price < Number(l.product.price_min);
    const room = l.product ? Math.max(0, l.product.wh_available + (heldFor[l.product.id] ?? 0)) : 0;
    const short = fulfilment === "from_stock" && !!l.product && pieces !== null && pieces > room;
    return { l, pieces, price, below, short, room, total: pieces !== null && price !== null ? Math.round(pieces * price * 100) / 100 : 0 };
  });
  const anyBelow = parsed.some((p) => p.below);
  const total = parsed.reduce((s, p) => s + p.total, 0);
  const dupes = new Set<string>();
  const hasDupes = parsed.some((p) => p.l.product && (dupes.has(p.l.product.id) || !dupes.add(p.l.product.id)));
  const reason: string | null = !chosenLead
    ? t("needLead")
    : parsed.some((p) => (fulfilment === "from_stock" ? !p.l.product : !p.l.product && !p.l.description.trim()))
      ? t("needProduct")
      : parsed.some((p) => p.pieces === null || p.pieces < 1)
        ? t("needQuantity")
        : parsed.some((p) => p.price === null)
          ? t("needPrice")
          : hasDupes
            ? t("duplicate")
            : parsed.find((p) => p.short)
              ? t("onlyAvailable", { available: qty(parsed.find((p) => p.short)!.room, parsed.find((p) => p.short)!.l.product!.pieces_per_carton) })
              : anyBelow && !canSellBelowMin
                ? t("belowMinRep")
                : anyBelow && !belowOk
                  ? t("belowMinConfirm")
                  : null;

  const submit = async () => {
    if (reason || busy || !chosenLead) return;
    setBusy(true);
    setFailure(null);
    const input = {
      companyId: chosenLead.id,
      fulfilment,
      lines: parsed.map((p) => ({
        product_id: p.l.product?.id ?? null,
        description: p.l.product ? null : p.l.description.trim(),
        quantity: p.pieces as number,
        unit_price: String(p.price),
      })),
      dealId,
      note: fulfilment === "direct_from_source" && note.trim() ? note.trim() : null,
      shipToCountry: fulfilment === "direct_from_source" && /^[A-Za-z]{2}$/.test(country.trim()) ? country.trim().toUpperCase() : null,
      stockRequestId: prefill?.stockRequestId ?? null,
      allowBelowMin: anyBelow && belowOk,
      requestId: reqId,
    };
    let res = await recordSale(input).catch(() => null);
    if (!res) res = await recordSale(input).catch(() => null); // a dropped connection: the same request id never sells twice
    setBusy(false);
    refreshSales(queryClient, chosenLead.id);
    if (!res || !res.ok) {
      setFailure(res ?? { ok: false, error: "unavailable" });
      return;
    }
    const sale = res.data;
    onOpenChange(false);
    toast.show(
      [
        t("recorded", {
          number: sale.number,
          lines: sale.line_count,
          total: format.number(Number(sale.total), { style: "currency", currency: "EUR" }),
        }),
        sale.became_customer ? t("becameCustomer") : null,
      ]
        .filter(Boolean)
        .join(" · "),
      {
        label: t("undo"),
        run: () =>
          void undoSale(sale.order_id)
            .then((u) => {
              refreshSales(queryClient, chosenLead.id);
              toast.show(u.ok ? t("undone", { number: sale.number }) : errorText(u));
            })
            .catch(() => toast.show(errorText({ ok: false, error: "unavailable" }))),
      },
      { duration: 120_000 },
    );
  };
  const onShortcut = useEffectEvent((e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  });
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => onShortcut(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open]);

  const setLine = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        aria-describedby={`${formId}-desc`}
        className={cn(phoneSheet, "max-h-[calc(100dvh-24px)] overflow-y-auto overscroll-contain sm:top-[5vh] sm:max-h-[90vh] sm:w-[min(720px,calc(100%-32px))]")}
      >
        <form
          id={formId}
          className="flex flex-col gap-5 p-5 sm:p-6"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1">
            <DialogTitle className="text-xl font-bold tracking-[-0.03em]">{t("title")}</DialogTitle>
            <DialogDescription id={`${formId}-desc`} className="text-sm text-muted-foreground">
              {t("body")}
            </DialogDescription>
          </div>

          {lead ? (
            <p className="flex flex-col gap-0.5 text-sm">
              <span className="text-muted-foreground">{t("lead")}</span>
              <span className="font-bold" translate="no">
                {lead.name}
              </span>
            </p>
          ) : chosenLead ? (
            <div className="flex items-center justify-between gap-2 rounded-md bg-muted px-3 py-2">
              <span className="truncate font-bold" translate="no">
                {chosenLead.name}
              </span>
              <Button type="button" variant="link" onClick={() => setChosenLead(null)}>
                {t("changeLead")}
              </Button>
            </div>
          ) : (
            <LeadPicker
              label={t("lead")}
              autoFocus
              onPick={(l) => {
                setChosenLead({ id: l.id, name: l.name });
                focusField(formId, "product");
              }}
            />
          )}

          <div role="radiogroup" aria-label={t("type")} className="grid grid-cols-2 rounded-md bg-muted p-1">
            {(["from_stock", "direct_from_source"] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={fulfilment === f}
                onClick={() => {
                  setFulfilment(f);
                  setDealId(null);
                }}
                className={cn(
                  "min-h-11 rounded-[10px] px-3 text-sm font-bold transition-[color,transform] duration-150 active:scale-[0.97]",
                  fulfilment === f ? "bg-pill text-foreground shadow-[0_1px_3px_rgb(14_14_16/0.12)]" : "text-muted-foreground",
                )}
              >
                {tc(`fulfilment.${f}`)}
              </button>
            ))}
          </div>
          {fulfilment === "direct_from_source" ? <p className="-mt-3 text-sm text-muted-foreground">{t("supplierHint")}</p> : null}

          <ol className="flex flex-col gap-4">
            {parsed.map((p, i) => (
              <li key={p.l.key} className="flex flex-col gap-3 rounded-lg border border-border p-4">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-mono text-xs text-muted-foreground">{t("lineN", { n: i + 1 })}</span>
                  {lines.length > 1 ? (
                    <button
                      type="button"
                      aria-label={t("removeLine", { n: i + 1 })}
                      onClick={() => setLines((ls) => ls.filter((x) => x.key !== p.l.key))}
                      className="grid size-11 place-items-center rounded-md text-muted-foreground hover:text-foreground sm:size-9"
                    >
                      <X aria-hidden="true" strokeWidth={1.75} className="size-4" />
                    </button>
                  ) : null}
                </div>
                {p.l.product ? (
                  <div className="flex items-center justify-between gap-2 rounded-md bg-muted px-3 py-2">
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-bold" translate="no">
                        {p.l.product.name}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {t("available", { available: qty(p.room, p.l.product.pieces_per_carton) })}
                      </span>
                    </span>
                    <Button
                      type="button"
                      variant="link"
                      onClick={() => {
                        setLine(p.l.key, { product: null });
                        focusField(formId, "product", i);
                      }}
                    >
                      {t("changeProduct")}
                    </Button>
                  </div>
                ) : (
                  <>
                    <ProductPicker
                      label={t("product")}
                      autoFocus={!!chosenLead && i === lines.length - 1}
                      heldFor={heldFor}
                      onPick={(pr) => {
                        // A price typed while the search was still loading stays.
                        setLine(p.l.key, { product: pr, priceText: p.l.priceText.trim() ? p.l.priceText : priceText(pr.price_max) });
                        focusField(formId, `quantity-${i}`);
                      }}
                    />
                    {fulfilment === "direct_from_source" ? (
                      <label className="flex flex-col gap-2 text-sm font-bold">
                        {t("description")}
                        <input
                          name={`description-${i}`}
                          autoComplete="off"
                          maxLength={200}
                          value={p.l.description}
                          onChange={(e) => setLine(p.l.key, { description: e.target.value })}
                          className="min-h-11 rounded-md border border-border bg-background px-3 text-base font-normal"
                        />
                      </label>
                    ) : null}
                  </>
                )}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,200px)]">
                  <QuantityField
                    label={t("quantity")}
                    name={`quantity-${i}`}
                    text={p.l.qtyText}
                    onText={(v) => setLine(p.l.key, { qtyText: v })}
                    unit={p.l.unit}
                    onUnit={(u) => setLine(p.l.key, { unit: u })}
                    piecesPerCarton={p.l.product?.pieces_per_carton ?? 1}
                    invalid={p.short}
                  />
                  <div className="flex flex-col gap-2">
                    <label htmlFor={`${formId}-price-${i}`} className="text-sm font-bold">
                      {t("price")}
                    </label>
                    <input
                      id={`${formId}-price-${i}`}
                      name={`price-${i}`}
                      inputMode="decimal"
                      autoComplete="off"
                      value={p.l.priceText}
                      onChange={(e) => setLine(p.l.key, { priceText: e.target.value })}
                      aria-invalid={p.below || undefined}
                      aria-describedby={`${formId}-price-${i}-hint`}
                      className="min-h-11 rounded-md border border-border bg-background px-3 text-right font-mono text-base"
                    />
                    <p id={`${formId}-price-${i}-hint`} className="min-h-5 font-mono text-xs text-muted-foreground">
                      {p.l.product
                        ? t("minMax", {
                            min: p.l.product.price_min === null ? "–" : format.number(Number(p.l.product.price_min), { style: "currency", currency: "EUR" }),
                            max: p.l.product.price_max === null ? "–" : format.number(Number(p.l.product.price_max), { style: "currency", currency: "EUR" }),
                          })
                        : t("exVat")}
                    </p>
                  </div>
                </div>
                {p.below ? (
                  <p className="flex items-center gap-2 text-sm">
                    <span aria-hidden="true" className="size-1.5 rounded-full bg-status-amber" />
                    {t("belowMin")}
                  </p>
                ) : null}
                <p className="text-right font-mono text-sm tabular-nums">
                  {format.number(p.total, { style: "currency", currency: "EUR" })}
                </p>
              </li>
            ))}
          </ol>
          <Button type="button" variant="quiet" className="self-start" onClick={() => setLines((ls) => [...ls, blankLine()])}>
            <Plus aria-hidden="true" strokeWidth={2} className="size-4" />
            {t("addLine")}
          </Button>

          {deals.length > 0 ? (
            <label className="flex flex-col gap-2 text-sm font-bold">
              {t("deal")}
              <select
                name="deal"
                value={dealId ?? ""}
                onChange={(e) => setDealId(e.target.value || null)}
                className="min-h-11 rounded-md border border-border bg-background px-3 text-base font-normal"
              >
                <option value="">{t("noDeal")}</option>
                {deals.map((d) => (
                  <option key={d.id} value={d.id}>
                    {[d.stage, format.number(Number(d.value), { style: "currency", currency: d.currency })].filter(Boolean).join(" · ")}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {fulfilment === "direct_from_source" ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[160px_minmax(0,1fr)]">
              <label className="flex flex-col gap-2 text-sm font-bold">
                {t("shipTo")}
                <input
                  name="ship_to_country"
                  autoComplete="off"
                  maxLength={2}
                  placeholder="FR"
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  className="min-h-11 rounded-md border border-border bg-background px-3 font-mono text-base font-normal uppercase"
                />
              </label>
              <label className="flex flex-col gap-2 text-sm font-bold">
                {t("note")}
                <input
                  name="note"
                  autoComplete="off"
                  maxLength={1000}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  className="min-h-11 rounded-md border border-border bg-background px-3 text-base font-normal"
                />
              </label>
            </div>
          ) : null}

          {anyBelow && canSellBelowMin ? (
            <label className="flex min-h-11 items-center gap-3 rounded-md bg-muted px-3 text-sm">
              <input type="checkbox" name="below_min" checked={belowOk} onChange={(e) => setBelowOk(e.target.checked)} className="size-5" />
              {t("sellAnyway")}
            </label>
          ) : null}

          {failure ? (
            <p role="alert" className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-sm">
              <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-status-red" />
              {errorText(failure)}
            </p>
          ) : null}

          <div className="sticky bottom-0 -mx-5 flex flex-col gap-3 border-t border-border bg-background px-5 pt-4 pb-1 sm:-mx-6 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <p className="flex items-baseline gap-2">
              <span className="text-sm text-muted-foreground">{t("total")}</span>
              <span className="font-mono text-xl tabular-nums">{format.number(total, { style: "currency", currency: "EUR" })}</span>
            </p>
            <div className="flex flex-col items-stretch gap-1 sm:items-end">
              <Button type="submit" variant="neutral" aria-disabled={!!reason || busy || undefined} aria-describedby={`${formId}-why`}>
                {busy ? t("recording") : t("record")}
                {modKey ? <Kbd className="max-sm:hidden">{`${modKey} ↩`}</Kbd> : null}
              </Button>
              <p id={`${formId}-why`} className="min-h-5 text-xs text-muted-foreground" aria-live="polite">
                {reason ?? ""}
              </p>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
