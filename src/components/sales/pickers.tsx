"use client";

import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Search } from "lucide-react";
import { searchProducts } from "@/components/sales/use-sales";
import { useQtyText } from "@/components/inventory/bits";
import type { StockRow } from "@/lib/inventory/types";
import type { LeadRow } from "@/lib/leads";
import { cn } from "@/lib/utils";

// Comboboxes for the sale, hold and request sheets (ARIA 1.2 combobox pattern): type a few letters, arrows to move,
// Enter to pick, Escape to close. Results come from the read-only list routes (searched in the database).

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

type Option<T> = { key: string; item: T };

function Combobox<T>({
  label,
  placeholder,
  value,
  load,
  render,
  onPick,
  autoFocus,
  name,
  emptyText,
}: {
  label: string;
  placeholder: string;
  value: string;
  load: (q: string) => Promise<Option<T>[]>;
  render: (item: T) => React.ReactNode;
  onPick: (item: T) => void;
  autoFocus?: boolean;
  name: string;
  emptyText: string;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<Option<T>[] | null>(null);
  const [active, setActive] = useState(0);
  const query = useDebounced(text, 150);
  const seq = useRef(0);
  const loadNow = useEffectEvent((q: string) => load(q));
  useEffect(() => {
    if (!open) return;
    const n = ++seq.current;
    loadNow(query)
      .then((o) => {
        if (n === seq.current) {
          setOptions(o);
          setActive(0);
        }
      })
      .catch(() => n === seq.current && setOptions([]));
  }, [query, open]);
  const pick = (o: Option<T>) => {
    onPick(o.item);
    setOpen(false);
  };
  return (
    <div className="relative flex min-w-0 flex-col gap-2">
      <label htmlFor={id} className="text-sm font-bold">
        {label}
      </label>
      <div className="relative">
        <Search aria-hidden="true" strokeWidth={1.75} className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          id={id}
          name={name}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={open && options?.[active] ? `${id}-o${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          placeholder={placeholder}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setActive((a) => Math.min(a + 1, Math.max(0, (options?.length ?? 1) - 1)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter" && open && options?.[active]) {
              e.preventDefault();
              pick(options[active]);
            } else if (e.key === "Escape" && open) {
              e.stopPropagation();
              setOpen(false);
            }
          }}
          className="min-h-11 w-full min-w-0 rounded-md border border-border bg-background pr-3 pl-9 text-base text-foreground"
        />
      </div>
      {open ? (
        <ul
          id={`${id}-list`}
          role="listbox"
          aria-label={label}
          className="absolute top-full right-0 left-0 z-30 mt-1 max-h-72 overflow-y-auto overscroll-contain rounded-md border border-border bg-popover p-1 shadow-lg"
        >
          {options === null ? (
            <li className="px-3 py-2 text-sm text-muted-foreground" aria-busy="true">
              <span className="block h-4 w-40 rounded-sm bg-muted motion-safe:animate-pulse" />
            </li>
          ) : options.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted-foreground">{emptyText}</li>
          ) : (
            options.map((o, i) => (
              <li
                key={o.key}
                id={`${id}-o${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(o);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn("flex min-h-11 cursor-pointer flex-col justify-center rounded-[10px] px-3 py-1.5", i === active && "bg-muted")}
              >
                {render(o.item)}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

/** A product with its live availability and prices ("4 200 pcs available · €2.50 max"). */
export function ProductPicker({
  label,
  onPick,
  autoFocus,
  heldFor,
}: {
  label: string;
  onPick: (p: StockRow) => void;
  autoFocus?: boolean;
  /** Pieces held for this lead per product (shown as "incl. 300 held for this lead"). */
  heldFor?: Record<string, number>;
}) {
  const t = useTranslations("Sales.picker");
  const format = useFormatter();
  const qty = useQtyText();
  return (
    <Combobox<StockRow>
      label={label}
      name="product"
      placeholder={t("productPlaceholder")}
      emptyText={t("noProduct")}
      value=""
      autoFocus={autoFocus}
      load={(q) => searchProducts(q).then((rows) => rows.filter((r) => !r.archived).map((r) => ({ key: r.id, item: r })))}
      onPick={onPick}
      render={(p) => (
        <>
          <span className={cn("truncate font-bold", p.wh_available <= 0 && "text-muted-foreground")} translate="no">
            {p.name}
          </span>
          <span className="truncate font-mono text-xs text-muted-foreground">
            {t("productLine", {
              available: qty(Math.max(0, p.wh_available + (heldFor?.[p.id] ?? 0)), p.pieces_per_carton),
              max: p.price_max === null ? t("noPrice") : format.number(Number(p.price_max), { style: "currency", currency: "EUR" }),
            })}
            {heldFor?.[p.id] ? ` · ${t("heldForLead", { held: qty(heldFor[p.id], p.pieces_per_carton) })}` : ""}
          </span>
        </>
      )}
    />
  );
}

type LeadPage = { rows: LeadRow[] };

/** A lead by name (the leads list search). */
export function LeadPicker({ label, onPick, autoFocus }: { label: string; onPick: (l: LeadRow) => void; autoFocus?: boolean }) {
  const t = useTranslations("Sales.picker");
  return (
    <Combobox<LeadRow>
      label={label}
      name="lead"
      placeholder={t("leadPlaceholder")}
      emptyText={t("noLead")}
      value=""
      autoFocus={autoFocus}
      load={async (q) => {
        const p = new URLSearchParams();
        if (q.trim()) p.set("q", q.trim());
        const res = await fetch(`/api/leads?${p}`, { headers: { accept: "application/json" } });
        if (!res.ok) return [];
        const page = (await res.json()) as LeadPage;
        return page.rows.slice(0, 8).map((r) => ({ key: r.id, item: r }));
      }}
      onPick={onPick}
      render={(l) => (
        <>
          <span className="truncate font-bold" translate="no">
            {l.name}
          </span>
          <span className="truncate text-xs text-muted-foreground">{[l.city, l.country].filter(Boolean).join(" · ")}</span>
        </>
      )}
    />
  );
}
