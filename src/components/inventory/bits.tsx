"use client";

import { useId, useSyncExternalStore } from "react";
import { useLocale, useTranslations } from "next-intl";
import { pieces as fmtPieces } from "@/lib/inventory/format";
import { stockStatusTone } from "@/lib/inventory/status";
import type { StockStatus } from "@/lib/inventory/types";
import { packs, type QtyUnit } from "@/lib/inventory/units";
import { cn } from "@/lib/utils";

// Small shared pieces of the Inventory screens: the status badge, the pcs/ctn preference, quantities and the quantity
// field with its cartons toggle (design D12 and 10.1).

const dot = { neutral: "bg-muted-foreground", amber: "bg-status-amber", green: "bg-status-green", red: "bg-status-red" } as const;

/** A dot plus a word (DESIGN.md: the word carries the meaning). */
export function StockStatusBadge({ status, className }: { status: StockStatus; className?: string }) {
  const t = useTranslations("Inventory.status");
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1.5 rounded-sm bg-muted px-2 py-0.5 text-xs whitespace-nowrap text-foreground", className)}>
      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", dot[stockStatusTone[status]])} />
      <span className="truncate">{t(status)}</span>
    </span>
  );
}

// The pcs/ctn display preference: a per-person convenience in this browser (try/catch: storage may be blocked).
const unitKey = "topstock.inventory.unit";
const unitListeners = new Set<() => void>();
let unitCache: QtyUnit | null = null;
function readUnit(): QtyUnit {
  try {
    return window.localStorage.getItem(unitKey) === "carton" ? "carton" : "piece";
  } catch {
    return "piece";
  }
}
export function setDisplayUnit(next: QtyUnit) {
  unitCache = next;
  try {
    window.localStorage.setItem(unitKey, next);
  } catch {
    // Not saved; still applies for this visit.
  }
  unitListeners.forEach((l) => l());
}
export function useDisplayUnit(): QtyUnit {
  return useSyncExternalStore(
    (cb) => {
      unitListeners.add(cb);
      return () => unitListeners.delete(cb);
    },
    () => (unitCache ??= readUnit()),
    () => "piece",
  );
}

/** "1 200 pcs", or "50 ctn + 10 pcs" in cartons mode. */
export function useQtyText() {
  const t = useTranslations("Inventory.units");
  const locale = useLocale();
  return (value: number, ppc: number, unit: QtyUnit = "piece") => {
    if (unit === "piece" || ppc <= 1) return t("pcs", { n: fmtPieces(locale, value) });
    const { cartons, loose } = packs(value, ppc);
    if (loose === 0) return t("ctn", { n: fmtPieces(locale, cartons) });
    return t("ctnPlus", { ctn: fmtPieces(locale, cartons), pcs: fmtPieces(locale, loose) });
  };
}

/** A segmented pcs | ctn switch (44 px on phones). */
export function UnitToggle({ value, onChange, label, className }: { value: QtyUnit; onChange: (u: QtyUnit) => void; label: string; className?: string }) {
  const t = useTranslations("Inventory.units");
  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex shrink-0 rounded-md bg-muted p-1", className)}>
      {(["piece", "carton"] as const).map((u) => (
        <button
          key={u}
          type="button"
          role="radio"
          aria-checked={value === u}
          onClick={() => onChange(u)}
          className={cn(
            "min-h-11 min-w-12 rounded-[10px] px-3 font-mono text-sm transition-[color,transform] duration-150 active:scale-[0.97] sm:min-h-9",
            value === u ? "bg-pill text-foreground shadow-[0_1px_3px_rgb(14_14_16/0.12)]" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {u === "piece" ? t("pcsShort") : t("ctnShort")}
        </button>
      ))}
    </div>
  );
}

/**
 * A quantity field typed in pieces (default) or cartons, with the conversion said live ("= 3 ctn + 12 pcs"). The value
 * handed up is always pieces (null while it is not a whole number).
 */
export function QuantityField({
  label,
  text,
  onText,
  unit,
  onUnit,
  piecesPerCarton,
  invalid,
  describedBy,
  autoFocus,
  name,
}: {
  label: string;
  text: string;
  onText: (t: string) => void;
  unit: QtyUnit;
  onUnit: (u: QtyUnit) => void;
  piecesPerCarton: number;
  invalid?: boolean;
  describedBy?: string;
  autoFocus?: boolean;
  name?: string;
}) {
  const id = useId();
  const t = useTranslations("Inventory.units");
  const qty = useQtyText();
  const n = /^\d{1,9}$/.test(text.replace(/[\s  ]/g, "")) ? Number(text.replace(/[\s  ]/g, "")) : null;
  const piecesNow = n === null ? null : unit === "carton" ? n * piecesPerCarton : n;
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-bold">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          name={name}
          inputMode="numeric"
          autoComplete="off"
          autoFocus={autoFocus}
          value={text}
          onChange={(e) => onText(e.target.value)}
          aria-invalid={invalid || undefined}
          aria-describedby={`${id}-hint${describedBy ? ` ${describedBy}` : ""}`}
          className="min-h-11 w-full min-w-0 rounded-md border border-border bg-background px-3 text-right font-mono text-base text-foreground aria-invalid:border-status-red"
        />
        <UnitToggle value={unit} onChange={onUnit} label={t("toggleLabel")} />
      </div>
      <p id={`${id}-hint`} aria-live="polite" className="min-h-5 font-mono text-xs text-muted-foreground">
        {piecesNow !== null && piecesPerCarton > 1
          ? unit === "carton"
            ? `= ${qty(piecesNow, piecesPerCarton, "piece")}`
            : `= ${qty(piecesNow, piecesPerCarton, "carton")}`
          : ""}
      </p>
    </div>
  );
}

/** Pieces from a QuantityField's text, or null. */
export function fieldPieces(text: string, unit: QtyUnit, piecesPerCarton: number): number | null {
  const cleaned = text.replace(/[\s  ]/g, "");
  if (!/^\d{1,9}$/.test(cleaned)) return null;
  const n = Number(cleaned);
  const total = unit === "carton" ? n * piecesPerCarton : n;
  return total <= 50_000_000 ? total : null;
}

/** A labelled number in the product panel's grid (DM Mono, right-aligned figures). */
export function Figure({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-md bg-muted/60 p-3">
      <dt className="text-xs text-pretty break-words text-muted-foreground">{label}</dt>
      <dd className="font-mono text-lg leading-tight tabular-nums">{value}</dd>
      {sub ? <dd className="truncate font-mono text-xs text-muted-foreground">{sub}</dd> : null}
    </div>
  );
}
