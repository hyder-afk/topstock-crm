"use client";

import { useId, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { correctStock, markArrived, receiveStock } from "@/app/(app)/inventory/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, phoneSheet } from "@/components/ui/dialog";
import { FormMessage } from "@/components/ui/form-message";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { QuantityField, fieldPieces, useQtyText } from "@/components/inventory/bits";
import { refreshInventory } from "@/components/inventory/use-inventory";
import { requestId, runWithStepUp, useStockErrorText, type StepUp } from "@/components/inventory/stock-actions";
import { CORRECTION_REASONS, RECEIVE_REASONS } from "@/lib/inventory/schemas";
import { pieces as fmtPieces } from "@/lib/inventory/format";
import type { Place, ProductDetail } from "@/lib/inventory/types";
import type { QtyUnit } from "@/lib/inventory/units";
import { cn } from "@/lib/utils";

type ProductLike = Pick<ProductDetail, "id" | "name" | "pieces_per_carton" | "wh_on_hand" | "wh_reserved" | "tr_on_hand" | "tr_reserved"> & {
  holds?: ProductDetail["holds"];
};

function Chips<T extends string>({ label, options, value, onChange, word }: { label: string; options: readonly T[]; value: T; onChange: (v: T) => void; word: (v: T) => string }) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-2 text-sm font-bold">{label}</legend>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={value === o}
            onClick={() => onChange(o)}
            className={cn(
              "min-h-11 rounded-md border px-3 text-sm transition-[color,background-color,transform,scale] duration-150 active:scale-[0.97] sm:min-h-9",
              value === o ? "border-foreground bg-foreground text-background" : "border-border bg-background text-foreground hover:bg-muted",
            )}
          >
            {word(o)}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

// Correct stock (design 6.5): Set counted quantity / Add / Remove at one place, a reason chip and a note (required for
// Other). Receive (manual receipt): pieces in, with a reason. Both ask for a fresh code (design D20) and never go below
// what is held ("Release holds first"). Quantities are typed in pieces, or cartons with the toggle.
export function StockChangeDialog({
  open,
  onOpenChange,
  product,
  kind,
  stepUp,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: ProductLike;
  kind: "correct" | "receive";
  stepUp: StepUp;
}) {
  const t = useTranslations("Inventory.change");
  const tPlace = useTranslations("Inventory.place");
  const tReason = useTranslations("Inventory.reasons");
  const errorText = useStockErrorText();
  const qty = useQtyText();
  const locale = useLocale();
  const toast = useToast();
  const queryClient = useQueryClient();
  const id = useId();
  const [mode, setMode] = useState<"set" | "add" | "remove">("set");
  const [place, setPlace] = useState<Place>("warehouse");
  const [text, setText] = useState("");
  const [unit, setUnit] = useState<QtyUnit>("piece");
  const [reason, setReason] = useState<string>(kind === "receive" ? "received" : "count");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reqId, setReqId] = useState(requestId);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setMode("set");
      setPlace("warehouse");
      setText("");
      setUnit("piece");
      setReason(kind === "receive" ? "received" : "count");
      setNote("");
      setError(null);
      setReqId(requestId());
    }
  }
  const onHand = place === "warehouse" ? product.wh_on_hand : product.tr_on_hand;
  const held = place === "warehouse" ? product.wh_reserved : product.tr_reserved;
  const n = fieldPieces(text, unit, product.pieces_per_carton);
  const after = n === null ? null : kind === "receive" || mode === "add" ? onHand + n : mode === "remove" ? onHand - n : n;
  const belowHeld = after !== null && after < held;

  const submit = async () => {
    if (busy) return;
    if (n === null || (n === 0 && !(kind === "correct" && mode === "set"))) {
      setError(t("needQuantity"));
      return;
    }
    if (after !== null && after < 0) {
      setError(t("belowZero", { n: fmtPieces(locale, onHand) }));
      return;
    }
    if (belowHeld) {
      setError(t("releaseFirst", { n: fmtPieces(locale, held) }));
      return;
    }
    if (reason === "other" && !note.trim()) {
      setError(t("noteRequired"));
      document.getElementById(`${id}-note`)?.focus();
      return;
    }
    if (!(await stepUp.ensureFresh(60))) return;
    setBusy(true);
    setError(null);
    const res =
      kind === "receive"
        ? await runWithStepUp(stepUp, () =>
            receiveStock({ productId: product.id, place, pieces: n, reason, note: note.trim() || null, requestId: reqId }),
          )
        : await runWithStepUp(stepUp, () =>
            correctStock({
              productId: product.id,
              mode,
              place,
              pieces: n,
              reason: mode === "set" ? "count" : reason,
              note: note.trim() || null,
              requestId: reqId,
            }),
          );
    setBusy(false);
    if (!res) return;
    if (!res.ok) {
      setError(res.error === "stock_short" ? t("releaseFirst", { n: fmtPieces(locale, held) }) : errorText(res));
      refreshInventory(queryClient, product.id);
      return;
    }
    refreshInventory(queryClient, product.id);
    onOpenChange(false);
    toast.show(res.data.unchanged ? t("unchanged") : kind === "receive" ? t("received", { qty: qty(n, product.pieces_per_carton) }) : t("corrected"));
  };

  const reasons = kind === "receive" ? RECEIVE_REASONS : mode === "set" ? (["count"] as const) : CORRECTION_REASONS.filter((r) => r !== "count");

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className={cn(phoneSheet, "max-h-[calc(100dvh-24px)] overflow-y-auto overscroll-contain sm:w-[min(520px,calc(100%-32px))]")}>
        <form
          className="flex flex-col gap-5 p-5 sm:p-6"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1">
            <DialogTitle className="text-xl font-bold">{kind === "receive" ? t("receiveTitle") : t("correctTitle")}</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground" dir="auto">
              {product.name}
            </DialogDescription>
          </div>
          {kind === "correct" ? (
            <Chips
              label={t("mode")}
              options={["set", "add", "remove"] as const}
              value={mode}
              onChange={(m) => {
                setMode(m);
                setReason(m === "set" ? "count" : "damaged");
              }}
              word={(m) => t(`modes.${m}`)}
            />
          ) : null}
          <Chips label={t("place")} options={["warehouse", "transit"] as const} value={place} onChange={setPlace} word={(p) => tPlace(p)} />
          <p className="-mt-2 font-mono text-sm text-muted-foreground">
            {t("now", { onHand: qty(onHand, product.pieces_per_carton), held: qty(held, product.pieces_per_carton) })}
          </p>
          <QuantityField
            label={kind === "correct" && mode === "set" ? t("counted") : t("quantity")}
            text={text}
            onText={setText}
            unit={unit}
            onUnit={setUnit}
            piecesPerCarton={product.pieces_per_carton}
            invalid={!!error && (n === null || belowHeld)}
            describedBy={error ? `${id}-err` : undefined}
            autoFocus
          />
          {after !== null && after >= 0 ? (
            <p className={cn("-mt-3 font-mono text-sm", belowHeld ? "text-status-red" : "text-muted-foreground")}>
              {t("after", { qty: qty(after, product.pieces_per_carton) })}
            </p>
          ) : null}
          {reasons.length > 1 ? (
            <Chips label={t("reason")} options={reasons as readonly string[]} value={reason} onChange={setReason} word={(r) => tReason(r)} />
          ) : null}
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-note`}>{reason === "other" ? t("noteNeeded") : t("note")}</Label>
            <Textarea id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} dir="auto" />
          </div>
          <FormMessage id={`${id}-err`} tone="error">
            {error}
          </FormMessage>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="quiet" onClick={() => onOpenChange(false)} disabled={busy}>
              {t("cancel")}
            </Button>
            <Button type="submit" variant="neutral" aria-disabled={busy || undefined}>
              {busy ? t("saving") : kind === "receive" ? t("receive") : t("save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Arrived (design 6.4 and 10.3): "All 1 200 pcs arrived" (default) or "Only part arrived", with the holds that move to
// the warehouse listed. Managers and admins; no code.
export function ArrivedDialog({
  open,
  onOpenChange,
  product,
  stepUp,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: ProductLike;
  stepUp: StepUp;
}) {
  const t = useTranslations("Inventory.arrived");
  const errorText = useStockErrorText();
  const qty = useQtyText();
  const toast = useToast();
  const queryClient = useQueryClient();
  const id = useId();
  const [part, setPart] = useState(false);
  const [text, setText] = useState("");
  const [unit, setUnit] = useState<QtyUnit>("piece");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reqId, setReqId] = useState(requestId);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setPart(false);
      setText("");
      setUnit("piece");
      setError(null);
      setReqId(requestId());
    }
  }
  const transit = product.tr_on_hand;
  const n = part ? fieldPieces(text, unit, product.pieces_per_carton) : transit;
  const holds = (product.holds ?? []).filter((h) => h.location === "transit");
  // Held pieces travel first, oldest hold first (design 4.5): which holds move, whole or in part.
  const moving: { id: string; name: string; pieces: number }[] = [];
  let left = Math.min(n ?? 0, product.tr_reserved);
  for (const h of holds) {
    if (left <= 0) break;
    const take = Math.min(left, h.remaining);
    moving.push({ id: h.id, name: h.company_name ?? "", pieces: take });
    left -= take;
  }

  const submit = async () => {
    if (busy) return;
    if (n === null || n < 1 || n > transit) {
      setError(t("range", { qty: qty(transit, product.pieces_per_carton) }));
      return;
    }
    setBusy(true);
    setError(null);
    const res = await runWithStepUp(stepUp, () => markArrived({ productId: product.id, pieces: n, note: null, requestId: reqId }));
    setBusy(false);
    if (!res) return;
    if (!res.ok) {
      setError(errorText(res));
      refreshInventory(queryClient, product.id);
      return;
    }
    refreshInventory(queryClient, product.id);
    onOpenChange(false);
    toast.show(t("done", { qty: qty(n, product.pieces_per_carton) }));
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className={cn(phoneSheet, "max-h-[calc(100dvh-24px)] overflow-y-auto overscroll-contain sm:w-[min(520px,calc(100%-32px))]")}>
        <form
          className="flex flex-col gap-5 p-5 sm:p-6"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1">
            <DialogTitle className="text-xl font-bold">{t("title")}</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground" dir="auto">
              {product.name}
            </DialogDescription>
          </div>
          <div role="radiogroup" aria-label={t("how")} className="flex flex-col gap-2">
            {[false, true].map((p) => (
              <label key={String(p)} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-border px-3 has-[:checked]:border-foreground">
                <input type="radio" name={`${id}-part`} checked={part === p} onChange={() => setPart(p)} className="size-4 accent-foreground" />
                <span>{p ? t("part") : t("all", { qty: qty(transit, product.pieces_per_carton) })}</span>
              </label>
            ))}
          </div>
          {part ? (
            <QuantityField
              label={t("pieces")}
              text={text}
              onText={setText}
              unit={unit}
              onUnit={setUnit}
              piecesPerCarton={product.pieces_per_carton}
              invalid={!!error}
              describedBy={error ? `${id}-err` : undefined}
              autoFocus
            />
          ) : null}
          {moving.length > 0 ? (
            <div className="flex flex-col gap-2 rounded-md bg-muted/60 p-3">
              <p className="text-sm font-bold">{t("holdsMove")}</p>
              <ul className="flex flex-col gap-1 text-sm">
                {moving.map((m) => (
                  <li key={m.id} className="flex justify-between gap-3">
                    <span className="truncate" dir="auto">
                      {m.name}
                    </span>
                    <span className="shrink-0 font-mono">{qty(m.pieces, product.pieces_per_carton)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <FormMessage id={`${id}-err`} tone="error">
            {error}
          </FormMessage>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="quiet" onClick={() => onOpenChange(false)} disabled={busy}>
              {t("cancel")}
            </Button>
            <Button type="submit" variant="neutral" aria-disabled={busy || undefined}>
              {busy ? t("saving") : t("confirm")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
