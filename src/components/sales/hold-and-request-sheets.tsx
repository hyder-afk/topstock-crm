"use client";

import { useId, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { reserveStock } from "@/app/(app)/inventory/actions";
import { logStockRequest } from "@/app/(app)/inventory/sales/actions";
import { QuantityField, fieldPieces, useQtyText } from "@/components/inventory/bits";
import { requestId as newRequestId, useStockErrorText } from "@/components/inventory/stock-actions";
import { focusField } from "@/components/sales/bits";
import { LeadPicker, ProductPicker } from "@/components/sales/pickers";
import { refreshSales, useLeadStock } from "@/components/sales/use-sales";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Dialog, DialogContent, DialogDescription, DialogTitle, phoneSheet } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import type { StockFailure } from "@/lib/inventory/errors";
import type { StockRow } from "@/lib/inventory/types";
import type { QtyUnit } from "@/lib/inventory/units";
import type { StageKey } from "@/lib/deals";
import { dealOptionLabel, dealsForHold } from "@/lib/sales/deal-option";
import type { LeadDealOption } from "@/lib/sales/types";
import { cn } from "@/lib/utils";

type Product = Pick<StockRow, "id" | "name" | "pieces_per_carton" | "wh_available" | "tr_available" | "tr_on_hand">;
const today = () => new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Paris" }));
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const plusDays = (n: number) => {
  const d = today();
  d.setDate(d.getDate() + n);
  return isoDay(d);
};

// Hold stock for a lead (design 10.3): product, place (In transit when arriving stock is free), pieces or cartons,
// Until chips (7, 14, 30 days or a date within 90), the deal, a note. One tap, no code. Opened without a lead (a
// product's R, Cmd+K "Hold stock…"), it starts with the lead search and reads that lead's deals itself.
export function HoldSheet({
  open,
  onOpenChange,
  lead,
  deals,
  product: fixedProduct,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lead: { id: string; name: string } | null;
  deals?: LeadDealOption[];
  product?: Product | null;
}) {
  const t = useTranslations("Sales.hold");
  const tp = useTranslations("Sales.sheet");
  const qty = useQtyText();
  const format = useFormatter();
  const tDeal = useTranslations("Deals");
  const tStage = useTranslations("Stages");
  const dealWords = {
    untitled: tDeal("untitled"),
    stage: (key: StageKey) => tStage(key),
    money: (value: number, currency: string) => format.number(value, { style: "currency", currency }),
  };
  const errorText = useStockErrorText();
  const toast = useToast();
  const queryClient = useQueryClient();
  const formId = useId();
  const [product, setProduct] = useState<Product | null>(fixedProduct ?? null);
  const [chosenLead, setChosenLead] = useState(lead);
  const [place, setPlace] = useState<"warehouse" | "transit">("warehouse");
  const [text, setText] = useState("");
  const [unit, setUnit] = useState<QtyUnit>("piece");
  const [days, setDays] = useState<number | "pick">(14);
  const [picked, setPicked] = useState(plusDays(14));
  const [dealId, setDealId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [reqId, setReqId] = useState(() => newRequestId());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<StockFailure | null>(null);
  const [was, setWas] = useState(false);
  if (open !== was) {
    setWas(open);
    if (open) {
      setProduct(fixedProduct ?? null);
      setChosenLead(lead);
      setPlace("warehouse");
      setText("");
      setUnit("piece");
      setDays(14);
      setPicked(plusDays(14));
      setDealId(null);
      setNote("");
      setReqId(newRequestId());
      setFailure(null);
    }
  }
  const ppc = product?.pieces_per_carton ?? 1;
  const pieces = fieldPieces(text, unit, ppc);
  const room = product ? (place === "warehouse" ? product.wh_available : product.tr_available) : 0;
  const until = days === "pick" ? picked : plusDays(days);
  const leadStock = useLeadStock(open && !deals ? (chosenLead?.id ?? null) : null);
  const fromStockDeals = dealsForHold(deals ?? leadStock.data?.deals ?? []);
  const reason = !chosenLead
    ? tp("needLead")
    : !product
    ? t("needProduct")
    : pieces === null || pieces < 1
      ? t("needQuantity")
      : pieces > room
        ? t("onlyFree", { free: qty(Math.max(0, room), ppc) })
        : until < plusDays(0) || until > plusDays(90)
          ? t("untilRange")
          : null;
  const submit = async () => {
    if (reason || busy || !product || !chosenLead || pieces === null) return;
    setBusy(true);
    setFailure(null);
    const res = await reserveStock({
      productId: product.id,
      companyId: chosenLead.id,
      dealId,
      place,
      pieces,
      holdUntil: until,
      note: note.trim() || null,
      requestId: reqId,
    }).catch(() => null);
    setBusy(false);
    refreshSales(queryClient, chosenLead.id);
    if (!res || !res.ok) {
      setFailure(res ?? { ok: false, error: "unavailable" });
      return;
    }
    onOpenChange(false);
    toast.show(t("done", { pieces: qty(pieces, ppc), product: product.name, until: format.dateTime(new Date(`${until}T12:00:00`), { dateStyle: "medium" }) }));
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent aria-describedby={`${formId}-desc`} className={cn(phoneSheet, "max-h-[calc(100dvh-24px)] overflow-y-auto sm:w-[min(560px,calc(100%-32px))]")}>
        <form noValidate
          id={formId}
          className="flex flex-col gap-5 p-5 sm:p-6"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1">
            <DialogTitle className="text-xl font-bold tracking-[-0.03em]">{t("title")}</DialogTitle>
            <DialogDescription id={`${formId}-desc`} className="text-sm text-muted-foreground" translate={chosenLead ? "no" : undefined}>
              {chosenLead ? chosenLead.name : tp("needLead")}
            </DialogDescription>
          </div>
          {!lead ? (
            chosenLead ? (
              <div className="flex items-center justify-between gap-2 rounded-md bg-muted px-3 py-2">
                <span className="truncate font-bold" translate="no">
                  {chosenLead.name}
                </span>
                <Button type="button" variant="link" onClick={() => setChosenLead(null)}>
                  {tp("changeLead")}
                </Button>
              </div>
            ) : (
              <LeadPicker
                label={tp("lead")}
                autoFocus
                onPick={(l) => {
                  setChosenLead({ id: l.id, name: l.name });
                  setDealId(null);
                  focusField(formId, product ? "quantity" : "product");
                }}
              />
            )
          ) : null}
          {product ? (
            <div className="flex items-center justify-between gap-2 rounded-md bg-muted px-3 py-2">
              <span className="truncate font-bold" translate="no">
                {product.name}
              </span>
              {!fixedProduct ? (
                <Button type="button" variant="link" onClick={() => setProduct(null)}>
                  {t("changeProduct")}
                </Button>
              ) : null}
            </div>
          ) : (
            <ProductPicker
              label={t("product")}
              autoFocus={!!chosenLead}
              onPick={(p) => {
                setProduct(p);
                focusField(formId, "quantity");
              }}
            />
          )}
          {product && product.tr_on_hand > 0 ? (
            <div role="radiogroup" aria-label={t("place")} className="grid grid-cols-2 rounded-md bg-muted p-1">
              {(["warehouse", "transit"] as const).map((pl) => (
                <button
                  key={pl}
                  type="button"
                  role="radio"
                  aria-checked={place === pl}
                  onClick={() => setPlace(pl)}
                  className={cn(
                    "min-h-11 rounded-[10px] px-3 text-sm font-bold transition-[color,transform,scale] duration-150 active:scale-[0.97]",
                    place === pl ? "bg-pill text-foreground shadow-[0_1px_3px_rgb(14_14_16/0.12)]" : "text-muted-foreground",
                  )}
                >
                  {t(`places.${pl}`)}
                </button>
              ))}
            </div>
          ) : null}
          <QuantityField label={t("quantity")} name="quantity" text={text} onText={setText} unit={unit} onUnit={setUnit} piecesPerCarton={ppc} />
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-bold">{t("until")}</legend>
            <div className="flex flex-wrap gap-2">
              {([7, 14, 30, "pick"] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={days === d}
                  onClick={() => setDays(d)}
                  className={cn(
                    "min-h-11 rounded-full border px-4 text-sm transition-[transform,scale,background-color] duration-150 active:scale-[0.97] sm:min-h-9",
                    days === d ? "border-foreground bg-foreground text-background" : "border-border",
                  )}
                >
                  {d === "pick" ? t("pick") : t("days", { n: d })}
                </button>
              ))}
            </div>
            {days === "pick" ? (
              <DatePicker
                name="hold_until"
                aria-label={t("until")}
                min={plusDays(0)}
                max={plusDays(90)}
                value={picked}
                onValueChange={setPicked}
                required
                className="self-start"
              />
            ) : null}
          </fieldset>
          {fromStockDeals.length > 0 ? (
            <div className="flex flex-col gap-2 text-sm font-bold">
              <Label htmlFor={`${formId}-deal`}>{t("deal")}</Label>
              <Select id={`${formId}-deal`} name="deal" value={dealId ?? ""} onValueChange={(v) => setDealId(v || null)} className="text-base font-normal">
                <option value="">{t("noDeal")}</option>
                {fromStockDeals.map((d) => (
                  <option key={d.id} value={d.id}>
                    {dealOptionLabel(d, dealWords)}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          <label className="flex flex-col gap-2 text-sm font-bold">
            {t("note")}
            <input name="note" autoComplete="off" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} className="min-h-11 rounded-md border border-border bg-background px-3 text-base font-normal" />
          </label>
          {failure ? (
            <p role="alert" className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-sm">
              <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-status-red" />
              {errorText(failure)}
            </p>
          ) : null}
          <div className="flex flex-col items-stretch gap-1 sm:items-end">
            <Button type="submit" variant="neutral" aria-disabled={!!reason || busy || undefined} aria-describedby={`${formId}-why`}>
              {busy ? t("holding") : pieces && product ? t("holdN", { pieces: qty(pieces, ppc) }) : t("hold")}
            </Button>
            <p id={`${formId}-why`} className="min-h-5 text-xs text-muted-foreground" aria-live="polite">
              {reason ?? ""}
            </p>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type ReqLine = { key: string; product: Product | null; other: boolean; description: string; text: string; unit: QtyUnit };
const blank = (): ReqLine => ({ key: crypto.randomUUID(), product: null, other: false, description: "", text: "", unit: "piece" });

// Log a request from a call or a chat (design 6.9): products from the stock search or "Something not in the list",
// quantities, a note. No task: the person logging it is on it.
export function LogRequestSheet({ open, onOpenChange, lead }: { open: boolean; onOpenChange: (open: boolean) => void; lead: { id: string; name: string } }) {
  const t = useTranslations("Sales.request");
  const errorText = useStockErrorText();
  const toast = useToast();
  const queryClient = useQueryClient();
  const formId = useId();
  const [lines, setLines] = useState<ReqLine[]>([blank()]);
  const [note, setNote] = useState("");
  const [reqId, setReqId] = useState(() => newRequestId());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<StockFailure | null>(null);
  const [was, setWas] = useState(false);
  if (open !== was) {
    setWas(open);
    if (open) {
      setLines([blank()]);
      setNote("");
      setReqId(newRequestId());
      setFailure(null);
    }
  }
  const setLine = (key: string, patch: Partial<ReqLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const parsed = lines.map((l) => ({ l, n: /^\d{1,8}$/.test(l.text.replace(/[\s  ]/g, "")) ? Number(l.text.replace(/[\s  ]/g, "")) : null }));
  const reason = parsed.some((p) => (p.l.other ? !p.l.description.trim() : !p.l.product))
    ? t("needItem")
    : parsed.some((p) => p.n === null || p.n < 1)
      ? t("needQuantity")
      : null;
  const submit = async () => {
    if (reason || busy) return;
    setBusy(true);
    setFailure(null);
    const res = await logStockRequest({
      companyId: lead.id,
      lines: parsed.map((p) => ({
        product_id: p.l.other ? null : (p.l.product?.id ?? null),
        description: p.l.other ? p.l.description.trim() : null,
        quantity: p.n as number,
        unit: p.l.other ? "piece" : p.l.unit,
      })),
      note: note.trim() || null,
      requestId: reqId,
    }).catch(() => null);
    setBusy(false);
    refreshSales(queryClient, lead.id);
    if (!res || !res.ok) {
      setFailure(res ?? { ok: false, error: "unavailable" });
      return;
    }
    onOpenChange(false);
    toast.show(t("logged"));
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent aria-describedby={`${formId}-desc`} className={cn(phoneSheet, "max-h-[calc(100dvh-24px)] overflow-y-auto sm:w-[min(600px,calc(100%-32px))]")}>
        <form noValidate
          id={formId}
          className="flex flex-col gap-5 p-5 sm:p-6"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1">
            <DialogTitle className="text-xl font-bold tracking-[-0.03em]">{t("title")}</DialogTitle>
            <DialogDescription id={`${formId}-desc`} className="text-sm text-muted-foreground" translate="no">
              {lead.name}
            </DialogDescription>
          </div>
          <ol className="flex flex-col gap-4">
            {lines.map((l, i) => (
              <li key={l.key} className="flex flex-col gap-3 rounded-lg border border-border p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-muted-foreground">{t("lineN", { n: i + 1 })}</span>
                  {lines.length > 1 ? (
                    <button type="button" aria-label={t("removeLine", { n: i + 1 })} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} className="grid size-11 place-items-center rounded-md text-muted-foreground transition-[scale] duration-150 hover:text-foreground active:scale-[0.97] sm:size-9">
                      <X aria-hidden="true" strokeWidth={1.75} className="size-4" />
                    </button>
                  ) : null}
                </div>
                {l.other ? (
                  <label className="flex flex-col gap-2 text-sm font-bold">
                    {t("description")}
                    <input name={`description-${i}`} autoComplete="off" maxLength={200} value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} className="min-h-11 rounded-md border border-border bg-background px-3 text-base font-normal" />
                  </label>
                ) : l.product ? (
                  <div className="flex items-center justify-between gap-2 rounded-md bg-muted px-3 py-2">
                    <span className="truncate font-bold" translate="no">
                      {l.product.name}
                    </span>
                    <Button
                      type="button"
                      variant="link"
                      onClick={() => {
                        setLine(l.key, { product: null });
                        focusField(formId, "product", lines.filter((x) => !x.product || x.key === l.key).findIndex((x) => x.key === l.key));
                      }}
                    >
                      {t("changeProduct")}
                    </Button>
                  </div>
                ) : (
                  <ProductPicker
                    label={t("product")}
                    autoFocus={i === lines.length - 1}
                    onPick={(p) => {
                      setLine(l.key, { product: p });
                      focusField(formId, `quantity-${i}`);
                    }}
                  />
                )}
                <Button type="button" variant="link" className="self-start" onClick={() => setLine(l.key, { other: !l.other, product: null, unit: "piece" })}>
                  {l.other ? t("fromList") : t("notInList")}
                </Button>
                {l.other ? (
                  <label className="flex flex-col gap-2 text-sm font-bold">
                    {t("quantityPcs")}
                    <input name={`quantity-${i}`} inputMode="numeric" autoComplete="off" value={l.text} onChange={(e) => setLine(l.key, { text: e.target.value })} className="min-h-11 rounded-md border border-border bg-background px-3 text-right font-mono text-base" />
                  </label>
                ) : (
                  <QuantityField label={t("quantity")} name={`quantity-${i}`} text={l.text} onText={(v) => setLine(l.key, { text: v })} unit={l.unit} onUnit={(u) => setLine(l.key, { unit: u })} piecesPerCarton={l.product?.pieces_per_carton ?? 1} />
                )}
              </li>
            ))}
          </ol>
          {lines.length < 20 ? (
            <Button type="button" variant="quiet" className="self-start" onClick={() => setLines((ls) => [...ls, blank()])}>
              <Plus aria-hidden="true" strokeWidth={2} className="size-4" />
              {t("addLine")}
            </Button>
          ) : null}
          <label className="flex flex-col gap-2 text-sm font-bold">
            {t("note")}
            <textarea name="note" maxLength={1000} rows={3} value={note} onChange={(e) => setNote(e.target.value)} className="rounded-md border border-border bg-background px-3 py-2 text-base font-normal" />
          </label>
          {failure ? (
            <p role="alert" className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-sm">
              <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-status-red" />
              {errorText(failure)}
            </p>
          ) : null}
          <div className="flex flex-col items-stretch gap-1 sm:items-end">
            <Button type="submit" variant="neutral" aria-disabled={!!reason || busy || undefined} aria-describedby={`${formId}-why`}>
              {busy ? t("logging") : t("log")}
            </Button>
            <p id={`${formId}-why`} className="min-h-5 text-xs text-muted-foreground" aria-live="polite">
              {reason ?? ""}
            </p>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
