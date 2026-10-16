"use client";

import { useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { createProduct, updateProduct } from "@/app/(app)/inventory/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, phoneSheet } from "@/components/ui/dialog";
import { FormMessage } from "@/components/ui/form-message";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { QuantityField, fieldPieces } from "@/components/inventory/bits";
import { refreshInventory } from "@/components/inventory/use-inventory";
import { requestId, runWithStepUp, useStockErrorText, type StepUp } from "@/components/inventory/stock-actions";
import type { StockFailure, StockHint } from "@/lib/inventory/errors";
import type { ProductDetail } from "@/lib/inventory/types";
import { parsePrice, parseWhole, type QtyUnit } from "@/lib/inventory/units";
import { cn } from "@/lib/utils";

type Field = "name" | "category" | "carton" | "pallet" | "reorder" | "priceMin" | "priceMax" | "eta" | "cost" | "opening";
const hintField: Partial<Record<StockHint, Field>> = {
  name_taken: "name",
  product_name: "name",
  category: "category",
  carton: "carton",
  pallet: "pallet",
  reorder: "reorder",
  price: "priceMax",
  price_order: "priceMin",
  eta: "eta",
  cost: "cost",
  quantity: "opening",
};

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));

// New product and Edit (design 10.1, managers and admins). Prices are EUR per piece excluding VAT; the cost per piece is
// shown to managers and admins only (it is never read by a rep). An opening quantity is a receipt and asks for a fresh
// code. Every value is checked again by the database, which answers with a hint that marks the field.
export function ProductFormDialog({
  open,
  onOpenChange,
  product,
  stepUp,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: ProductDetail | null; // null: a new product
  stepUp: StepUp;
  onCreated?: (id: string) => void;
}) {
  const t = useTranslations("Inventory.form");
  const errorText = useStockErrorText();
  const toast = useToast();
  const queryClient = useQueryClient();
  const id = useId();
  const editing = !!product;
  const [v, setV] = useState(() => initial(product));
  const [seen, setSeen] = useState({ open, product });
  if (seen.open !== open || seen.product?.id !== product?.id) {
    setSeen({ open, product });
    if (open) {
      setV(initial(product));
    }
  }
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ field: Field | null; text: string } | null>(null);
  const reqId = useRef(requestId());
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV((s) => ({ ...s, [k]: e.target.value }));

  const ppc = parseWhole(v.carton);
  const errorFor = (f: Field) => (failure?.field === f ? `${id}-err` : undefined);

  const submit = async () => {
    if (busy) return;
    const checks: [Field, boolean][] = [
      ["name", v.name.trim().length > 0 && v.name.trim().length <= 200],
      ["carton", ppc !== null && ppc >= 1 && ppc <= 1_000_000],
      ["pallet", v.pallet === "" || (parseWhole(v.pallet) ?? 0) >= 1],
      ["reorder", v.reorder === "" || parseWhole(v.reorder) !== null],
      ["priceMin", v.priceMin === "" || parsePrice(v.priceMin) !== null],
      ["priceMax", v.priceMax === "" || parsePrice(v.priceMax) !== null],
      ["cost", v.cost === "" || parsePrice(v.cost) !== null],
      ["opening", editing || v.opening === "" || fieldPieces(v.opening, v.openingUnit, ppc ?? 1) !== null],
    ];
    const bad = checks.find(([, ok]) => !ok);
    if (bad) {
      setFailure({ field: bad[0], text: t(`invalid.${bad[0]}`) });
      focusField(bad[0]);
      return;
    }
    const pmin = v.priceMin === "" ? null : parsePrice(v.priceMin);
    const pmax = v.priceMax === "" ? null : parsePrice(v.priceMax);
    if (pmin !== null && pmax !== null && pmin > pmax) {
      setFailure({ field: "priceMin", text: t("invalid.priceOrder") });
      focusField("priceMin");
      return;
    }
    const input = {
      name: v.name.trim(),
      category: v.category.trim() || null,
      piecesPerCarton: ppc as number,
      cartonsPerPallet: v.pallet === "" ? null : parseWhole(v.pallet),
      reorderPoint: v.reorder === "" ? null : parseWhole(v.reorder),
      priceMin: pmin,
      priceMax: pmax,
      transitEta: v.eta || null,
      shareVisible: v.shareVisible === "yes",
    };
    const cost = v.cost === "" ? null : parsePrice(v.cost);
    const opening = editing || v.opening === "" ? null : fieldPieces(v.opening, v.openingUnit, ppc as number);
    if (!editing && opening && !(await stepUp.ensureFresh(60))) return;
    setBusy(true);
    setFailure(null);
    const res = editing
      ? await runWithStepUp(stepUp, () => updateProduct(product.id, input, cost))
      : await runWithStepUp(stepUp, () =>
          createProduct({ product: input, costPerPiece: cost, openingQty: opening, openingPlace: v.openingPlace, requestId: reqId.current }),
        );
    setBusy(false);
    if (!res) return;
    if (!res.ok) {
      const f = res as StockFailure;
      const field = f.hint ? (hintField[f.hint] ?? null) : null;
      setFailure({ field, text: errorText(f) });
      if (field) focusField(field);
      return;
    }
    reqId.current = requestId();
    refreshInventory(queryClient, editing ? product.id : undefined);
    onOpenChange(false);
    toast.show(editing ? t("saved") : t("created", { name: input.name }));
    if (!editing && res.data && typeof res.data === "object" && "id" in res.data) onCreated?.(res.data.id);
  };

  const focusField = (f: Field) => requestAnimationFrame(() => document.getElementById(`${id}-${f}`)?.focus());

  const field = (f: Field, label: string, control: React.ReactNode, hint?: string) => (
    <div className="flex min-w-0 flex-col gap-2">
      <Label htmlFor={`${id}-${f}`}>{label}</Label>
      {control}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
  const inputProps = (f: Field) => ({
    id: `${id}-${f}`,
    name: f,
    autoComplete: "off",
    "aria-invalid": failure?.field === f || undefined,
    "aria-describedby": errorFor(f),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className={cn(phoneSheet, "max-h-[calc(100dvh-24px)] overflow-y-auto overscroll-contain sm:top-[6vh] sm:max-h-[88vh] sm:w-[min(640px,calc(100%-32px))]")}>
        <form
          className="flex flex-col gap-5 p-5 sm:p-6"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1">
            <DialogTitle className="text-xl font-bold">{editing ? t("editTitle") : t("newTitle")}</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">{t("body")}</DialogDescription>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              {field("name", t("name"), <Input {...inputProps("name")} value={v.name} onChange={set("name")} maxLength={200} autoFocus dir="auto" />)}
            </div>
            {field("category", t("category"), <Input {...inputProps("category")} value={v.category} onChange={set("category")} maxLength={80} dir="auto" />, t("categoryHint"))}
            {field("carton", t("carton"), <Input {...inputProps("carton")} value={v.carton} onChange={set("carton")} inputMode="numeric" className="text-right font-mono" />)}
            {field("priceMin", t("priceMin"), <Input {...inputProps("priceMin")} value={v.priceMin} onChange={set("priceMin")} inputMode="decimal" className="text-right font-mono" />, t("priceHint"))}
            {field("priceMax", t("priceMax"), <Input {...inputProps("priceMax")} value={v.priceMax} onChange={set("priceMax")} inputMode="decimal" className="text-right font-mono" />, t("priceMaxHint"))}
            {field("cost", t("cost"), <Input {...inputProps("cost")} value={v.cost} onChange={set("cost")} inputMode="decimal" className="text-right font-mono" />, t("costHint"))}
            {field("reorder", t("reorder"), <Input {...inputProps("reorder")} value={v.reorder} onChange={set("reorder")} inputMode="numeric" className="text-right font-mono" />, t("reorderHint"))}
            {field("pallet", t("pallet"), <Input {...inputProps("pallet")} value={v.pallet} onChange={set("pallet")} inputMode="numeric" className="text-right font-mono" />)}
            {field("eta", t("eta"), <DatePicker id={`${id}-eta`} name="eta" aria-invalid={failure?.field === "eta" || undefined} aria-describedby={errorFor("eta")} typed value={v.eta} onValueChange={(eta) => setV((s) => ({ ...s, eta }))} />, t("etaHint"))}
            <div className="flex min-w-0 flex-col gap-2">
              <Label htmlFor={`${id}-share`}>{t("shareVisible")}</Label>
              <Select id={`${id}-share`} value={v.shareVisible} onChange={set("shareVisible")}>
                <option value="yes">{t("shareYes")}</option>
                <option value="no">{t("shareNo")}</option>
              </Select>
            </div>
            {!editing ? (
              <>
                <div className="sm:col-span-1">
                  <QuantityField
                    label={t("opening")}
                    name="opening"
                    text={v.opening}
                    onText={(x) => setV((s) => ({ ...s, opening: x }))}
                    unit={v.openingUnit}
                    onUnit={(u) => setV((s) => ({ ...s, openingUnit: u }))}
                    piecesPerCarton={ppc ?? 1}
                    invalid={failure?.field === "opening"}
                    describedBy={errorFor("opening")}
                  />
                </div>
                <div className="flex min-w-0 flex-col gap-2">
                  <Label htmlFor={`${id}-place`}>{t("openingPlace")}</Label>
                  <Select id={`${id}-place`} value={v.openingPlace} onChange={set("openingPlace")}>
                    <option value="warehouse">{t("placeWarehouse")}</option>
                    <option value="transit">{t("placeTransit")}</option>
                  </Select>
                  <p className="text-xs text-muted-foreground">{t("openingHint")}</p>
                </div>
              </>
            ) : null}
          </div>
          <FormMessage id={`${id}-err`} tone="error">
            {failure?.text}
          </FormMessage>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="quiet" onClick={() => onOpenChange(false)} disabled={busy}>
              {t("cancel")}
            </Button>
            <Button type="submit" variant="neutral" aria-disabled={busy || undefined}>
              {busy ? t("saving") : editing ? t("save") : t("create")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function initial(p: ProductDetail | null) {
  return {
    name: p?.name ?? "",
    category: p?.category ?? "",
    carton: p ? String(p.pieces_per_carton) : "",
    pallet: fmt(p?.cartons_per_pallet),
    reorder: fmt(p?.reorder_point),
    priceMin: fmt(p?.price_min),
    priceMax: fmt(p?.price_max),
    cost: fmt(p?.cost_per_piece),
    eta: p?.transit_eta ?? "",
    shareVisible: p && !p.share_visible ? "no" : "yes",
    opening: "",
    openingUnit: "piece" as QtyUnit,
    openingPlace: "warehouse" as "warehouse" | "transit",
  };
}
