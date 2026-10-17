"use client";

import { useId, useMemo, useState } from "react";
import Link from "next/link";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { Truck } from "lucide-react";
import { markArrived, setProductEta } from "@/app/(app)/inventory/actions";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { useQtyText } from "@/components/inventory/bits";
import { movementDelta, useMovementText } from "@/components/inventory/movement-text";
import { ArrivedDialog } from "@/components/inventory/stock-dialogs";
import { requestId, useStockErrorText, type StepUp } from "@/components/inventory/stock-actions";
import { refreshInventory, useMovements, useReservations, useStock } from "@/components/inventory/use-inventory";
import { useReleaseHold } from "@/components/inventory/use-hold-actions";
import { MOVEMENT_GROUPS, type MovementFilters, type MovementGroup } from "@/lib/inventory/filters";
import { pieces as fmtPieces } from "@/lib/inventory/format";
import { productRef, weekStart } from "@/lib/inventory/status";
import type { StockRow } from "@/lib/inventory/types";
import { cn } from "@/lib/utils";

type Member = { id: string; first_name: string | null; last_name: string | null };

export function ListState({ kind, title, body, onRetry }: { kind: "empty" | "error"; title: string; body?: string; onRetry?: () => void }) {
  const t = useTranslations("Inventory");
  return (
    <div role={kind === "error" ? "alert" : undefined} className="flex flex-col items-start gap-3 rounded-lg bg-card p-6 sm:p-8">
      <h2 className="text-xl font-bold text-balance">{title}</h2>
      {body ? <p className="max-w-[60ch] text-muted-foreground">{body}</p> : null}
      {onRetry ? (
        <Button variant="quiet" onClick={onRetry}>
          {t("retry")}
        </Button>
      ) : null}
    </div>
  );
}

export function RowsSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className="flex flex-col overflow-hidden rounded-lg bg-card">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-[72px] items-center gap-4 border-b border-border px-4">
          <div className="flex flex-1 flex-col gap-2">
            <div className="h-4 w-1/3 rounded-sm bg-muted motion-safe:animate-pulse" />
            <div className="h-3 w-1/4 rounded-sm bg-muted motion-safe:animate-pulse" />
          </div>
          <div className="h-5 w-20 rounded-sm bg-muted motion-safe:animate-pulse" />
        </div>
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

// Arriving (design 10.1): products with stock in transit, their pieces and cartons, the holds on arriving goods, the
// expected week (managers and admins set the date inline), and Arrived (all or part); checkboxes plus "Mark selected
// arrived" (all of each selected product's transit pieces).
export function ArrivingList({ canManage, stepUp, onOpen }: { canManage: boolean; stepUp: StepUp; onOpen: (id: string) => void }) {
  const t = useTranslations("Inventory.arriving");
  const ti = useTranslations("Inventory");
  const format = useFormatter();
  const qty = useQtyText();
  const toast = useToast();
  const errorText = useStockErrorText();
  const queryClient = useQueryClient();
  const query = useStock({ filter: "in_transit", sort: "name" }, { key: "", page: null });
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.rows) ?? [], [query.data]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [arriving, setArriving] = useState<StockRow | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  if (query.isPending) return <RowsSkeleton rows={5} />;
  if (query.isError && rows.length === 0) return <ListState kind="error" title={t("error")} onRetry={() => void query.refetch()} />;
  if (rows.length === 0) return <ListState kind="empty" title={t("emptyTitle")} body={t("emptyBody")} />;

  const markSelected = async () => {
    if (bulkBusy) return;
    setBulkBusy(true);
    let done = 0;
    let failed: string | null = null;
    for (const r of rows.filter((x) => selected.has(x.id))) {
      const res = await markArrived({ productId: r.id, pieces: r.tr_on_hand, note: null, requestId: requestId() }).catch(() => null);
      if (res?.ok) done += 1;
      else failed = res ? errorText(res) : ti("errors.unavailable");
    }
    setBulkBusy(false);
    setSelected(new Set());
    refreshInventory(queryClient);
    toast.show(failed ? t("partly", { done, reason: failed }) : t("bulkDone", { count: done }));
  };

  return (
    <div className="flex flex-col gap-3">
      {canManage && selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
          <span className="px-1 font-bold">{t("selected", { count: selected.size })}</span>
          <button type="button" onClick={() => void markSelected()} aria-disabled={bulkBusy || undefined} className="min-h-11 rounded-md px-3 font-bold underline-offset-4 transition-[scale] duration-150 hover:underline active:scale-[0.97] aria-disabled:active:scale-100 sm:min-h-9">
            {bulkBusy ? t("marking") : t("markSelected")}
          </button>
          <button type="button" onClick={() => setSelected(new Set())} className="ml-auto min-h-11 rounded-md px-3 underline-offset-4 transition-[scale] duration-150 hover:underline active:scale-[0.97] sm:min-h-9">
            {t("clear")}
          </button>
        </div>
      ) : null}
      <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg bg-card">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-3 p-3 sm:flex-nowrap sm:px-4">
            {canManage ? (
              <label className="grid size-11 shrink-0 cursor-pointer place-items-center">
                <span className="sr-only">{t("select", { name: r.name })}</span>
                <input
                  type="checkbox"
                  checked={selected.has(r.id)}
                  onChange={(e) =>
                    setSelected((s) => {
                      const n = new Set(s);
                      if (e.target.checked) n.add(r.id);
                      else n.delete(r.id);
                      return n;
                    })
                  }
                  className="size-4 accent-foreground"
                />
              </label>
            ) : null}
            <button type="button" onClick={() => onOpen(r.id)} className="flex min-h-11 min-w-0 flex-1 flex-col items-start justify-center rounded-sm text-left transition-colors active:bg-muted/50">
              <span className="max-w-full truncate font-bold" dir="auto">{r.name}</span>
              <span className="text-xs text-muted-foreground">
                <span className="font-mono" translate="no">{productRef(r.number)}</span>
                {r.tr_reserved > 0 ? ` · ${t("held", { qty: qty(r.tr_reserved, r.pieces_per_carton) })}` : ""}
              </span>
            </button>
            <span className="flex shrink-0 flex-col items-end">
              <span className="font-mono">{qty(r.tr_on_hand, r.pieces_per_carton)}</span>
              <span className="font-mono text-xs text-muted-foreground">{qty(r.tr_on_hand, r.pieces_per_carton, "carton")}</span>
            </span>
            {canManage ? (
              <EtaField row={r} onSaved={() => refreshInventory(queryClient, r.id)} />
            ) : (
              <span className="w-36 shrink-0 text-right text-sm text-muted-foreground">
                {r.transit_eta
                  ? t("week", { date: format.dateTime(new Date(`${weekStart(r.transit_eta)}T12:00:00Z`), { day: "numeric", month: "short", timeZone: "UTC" }) })
                  : t("noEta")}
              </span>
            )}
            {canManage ? (
              <Button variant="quiet" className="min-h-11 shrink-0 px-3 text-sm sm:min-h-9" onClick={() => setArriving(r)}>
                <Truck aria-hidden="true" strokeWidth={1.75} className="size-4" />
                {t("arrived")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <MoreButton has={!!query.hasNextPage} busy={query.isFetchingNextPage} onMore={() => void query.fetchNextPage()} label={ti("showMore")} />
      {arriving ? (
        <ArrivedDialog
          open
          onOpenChange={(o) => !o && setArriving(null)}
          product={{ ...arriving, holds: [] }}
          stepUp={stepUp}
        />
      ) : null}
    </div>
  );
}

function EtaField({ row, onSaved }: { row: StockRow; onSaved: () => void }) {
  const t = useTranslations("Inventory.arriving");
  const toast = useToast();
  const errorText = useStockErrorText();
  const id = useId();
  const [value, setValue] = useState(row.transit_eta ?? "");
  const [seen, setSeen] = useState(row.transit_eta);
  if (seen !== row.transit_eta) {
    setSeen(row.transit_eta);
    setValue(row.transit_eta ?? "");
  }
  return (
    <span className="flex shrink-0 flex-col">
      <label htmlFor={id} className="sr-only">
        {t("etaFor", { name: row.name })}
      </label>
      <DatePicker
        id={id}
        name="eta"
        typed
        value={value}
        className="w-44"
        onValueChange={async (next) => {
          setValue(next);
          if ((next || null) === row.transit_eta) return;
          const res = await setProductEta({ productId: row.id, eta: next || null }).catch(() => null);
          if (!res || !res.ok) {
            setValue(row.transit_eta ?? "");
            toast.show(res ? errorText(res) : t("failed"));
            return;
          }
          onSaved();
          toast.show(t("etaSaved"));
        }}
      />
    </span>
  );
}

// Reserved (design 10.1): active holds, newest first: product, lead (link), deal, pieces, place, until (ended-but-not-
// swept holds flagged), by whom; Release (with Undo). Extend and Sell held come with 6d.
export function ReservedList({ me, canManage, onOpen }: { me: string; canManage: boolean; onOpen: (id: string) => void }) {
  const t = useTranslations("Inventory.reserved");
  const ti = useTranslations("Inventory");
  const tPlace = useTranslations("Inventory.place");
  const format = useFormatter();
  const qty = useQtyText();
  const release = useReleaseHold();
  const query = useReservations({ status: "active" });
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.rows) ?? [], [query.data]);
  const [busyId, setBusyId] = useState<string | null>(null);
  if (query.isPending) return <RowsSkeleton rows={6} />;
  if (query.isError && rows.length === 0) return <ListState kind="error" title={t("error")} onRetry={() => void query.refetch()} />;
  if (rows.length === 0) return <ListState kind="empty" title={t("emptyTitle")} body={t("emptyBody")} />;
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg bg-card">
        {rows.map((h) => (
          <li key={h.id} className="flex flex-wrap items-center gap-3 p-3 sm:flex-nowrap sm:px-4">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <button type="button" onClick={() => onOpen(h.product_id)} className="min-h-11 max-w-full truncate text-left font-bold underline-offset-4 hover:underline sm:min-h-0" dir="auto">
                {h.product_name}
              </button>
              <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                <Link href={`/leads/${h.company_id}?tab=stock`} className="inline-flex min-h-11 items-center truncate text-foreground underline-offset-4 hover:underline sm:min-h-0" dir="auto">
                  {h.company_name}
                </Link>
                <span>· {tPlace(h.location)}</span>
                {h.deal_id ? <span>· {t("deal")}</span> : null}
                <span>
                  ·{" "}
                  {h.ended ? (
                    <span className="text-status-amber">{t("ended")}</span>
                  ) : (
                    t("until", { date: format.dateTime(new Date(`${h.hold_until}T12:00:00Z`), { day: "numeric", month: "short", timeZone: "UTC" }) })
                  )}
                </span>
                {h.created_by_first_name ? <span>· {t("by", { name: h.created_by_first_name })}</span> : null}
              </span>
            </span>
            <span className="shrink-0 font-mono">{qty(h.remaining, h.pieces_per_carton)}</span>
            {canManage || h.created_by === me ? (
              <Button
                variant="quiet"
                className="min-h-11 shrink-0 px-3 text-sm sm:min-h-9"
                aria-disabled={busyId === h.id || undefined}
                aria-label={t("releaseOf", { product: h.product_name, lead: h.company_name ?? "" })}
                onClick={async () => {
                  if (busyId) return;
                  setBusyId(h.id);
                  await release(h, h.product_id);
                  setBusyId(null);
                }}
              >
                {t("release")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <MoreButton has={!!query.hasNextPage} busy={query.isFetchingNextPage} onMore={() => void query.fetchNextPage()} label={ti("showMore")} />
    </div>
  );
}

// Movements (design 10.1): the append-only log, newest first, with "Show older". An Arrived shows as one line (its
// departure from transit is folded in). Filters: kind, person, dates, and the product passed in the URL.
export function MovementsList({
  team,
  product,
  productName,
  onClearProduct,
  onOpen,
}: {
  team: Member[];
  product: string | null;
  productName: string | null;
  onClearProduct: () => void;
  onOpen: (id: string) => void;
}) {
  const t = useTranslations("Inventory.movements");
  const tPlace = useTranslations("Inventory.place");
  const tReason = useTranslations("Inventory.reasons");
  const format = useFormatter();
  const locale = useLocale();
  const say = useMovementText();
  const id = useId();
  const [group, setGroup] = useState<MovementGroup | "">("");
  const [user, setUser] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const filters: MovementFilters = {
    product: product ?? undefined,
    kinds: group ? [...MOVEMENT_GROUPS[group]] : undefined,
    user: user || undefined,
    from: from || undefined,
    to: to || undefined,
  };
  const query = useMovements(filters);
  const rows = useMemo(() => (query.data?.pages.flatMap((p) => p.rows) ?? []).filter((m) => m.kind !== "transfer_out"), [query.data]);
  const filtered = !!(group || user || from || to || product);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-0 flex-[1_1_160px] flex-col gap-1">
          <label htmlFor={`${id}-k`} className="text-xs text-muted-foreground">{t("kind")}</label>
          <Select id={`${id}-k`} value={group} onChange={(e) => setGroup(e.target.value as MovementGroup | "")} className="bg-card sm:min-h-10">
            <option value="">{t("allKinds")}</option>
            {(Object.keys(MOVEMENT_GROUPS) as MovementGroup[]).map((g) => (
              <option key={g} value={g}>{t(`groups.${g}`)}</option>
            ))}
          </Select>
        </div>
        <div className="flex min-w-0 flex-[1_1_160px] flex-col gap-1">
          <label htmlFor={`${id}-u`} className="text-xs text-muted-foreground">{t("person")}</label>
          <Select id={`${id}-u`} value={user} onChange={(e) => setUser(e.target.value)} className="bg-card sm:min-h-10">
            <option value="">{t("everyone")}</option>
            {team.map((m) => (
              <option key={m.id} value={m.id}>{[m.first_name, m.last_name].filter(Boolean).join(" ") || t("noName")}</option>
            ))}
          </Select>
        </div>
        <div className="flex flex-[1_1_140px] flex-col gap-1">
          <label htmlFor={`${id}-f`} className="text-xs text-muted-foreground">{t("from")}</label>
          <DatePicker id={`${id}-f`} name="from" typed value={from} max={to || undefined} onValueChange={setFrom} className="bg-card sm:min-h-10" />
        </div>
        <div className="flex flex-[1_1_140px] flex-col gap-1">
          <label htmlFor={`${id}-t`} className="text-xs text-muted-foreground">{t("to")}</label>
          <DatePicker id={`${id}-t`} name="to" typed value={to} min={from || undefined} onValueChange={setTo} className="bg-card sm:min-h-10" />
        </div>
      </div>
      {product ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="rounded-sm bg-muted px-2 py-1" dir="auto">{t("productChip", { name: productName ?? t("oneProduct") })}</span>
          <Button variant="link" className="min-h-11 text-sm sm:min-h-9" onClick={onClearProduct}>{t("allProducts")}</Button>
        </div>
      ) : null}
      {query.isPending ? (
        <RowsSkeleton rows={8} />
      ) : query.isError && rows.length === 0 ? (
        <ListState kind="error" title={t("error")} onRetry={() => void query.refetch()} />
      ) : rows.length === 0 ? (
        <ListState kind="empty" title={filtered ? t("noMatchTitle") : t("emptyTitle")} body={filtered ? t("noMatchBody") : t("emptyBody")} />
      ) : (
        <ul aria-label={t("label")} className="flex flex-col divide-y divide-border overflow-hidden rounded-lg bg-card">
          {rows.map((m) => {
            const d = movementDelta(m);
            const who = m.user_first_name ?? (m.user_id ? t("someone") : t("system"));
            return (
              <li key={m.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 p-3 text-sm sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto_auto] sm:px-4">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate font-bold">{say(m)}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    <time dateTime={m.created_at}>
                      {format.relativeTime(new Date(m.created_at))}<span className="sr-only"> ({format.dateTime(new Date(m.created_at), { dateStyle: "medium", timeStyle: "short" })})</span>
                    </time>
                    {" · "}
                    {who}
                  </span>
                </span>
                <span className="col-span-2 row-start-2 flex min-w-0 flex-col gap-0.5 sm:col-span-1 sm:row-start-auto">
                  <button type="button" onClick={() => onOpen(m.product_id)} className="min-h-11 max-w-full truncate text-left underline-offset-4 hover:underline sm:min-h-0" dir="auto">
                    {m.product_name}
                  </button>
                  <span className="truncate text-xs text-muted-foreground" dir="auto">
                    {m.kind === "transfer_in" ? t("transitToWarehouse") : tPlace(m.location)}
                    {m.company_name ? ` · ${m.company_name}` : ""}
                    {m.reason && !["arrived", "manual", "expired"].includes(m.reason) ? ` · ${tReason(m.reason)}` : ""}
                    {m.note ? ` · ${m.note}` : ""}
                  </span>
                </span>
                <span className={cn("row-start-1 text-right font-mono sm:row-start-auto", d.held && "text-muted-foreground")}>
                  {d.value > 0 ? "+" : "−"}
                  {fmtPieces(locale, Math.abs(d.value))}
                  {d.held ? <span className="text-xs"> {t("held")}</span> : null}
                </span>
                <span className="hidden text-right font-mono text-xs text-muted-foreground sm:block">
                  {t("left", { n: fmtPieces(locale, m.on_hand_after) })}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <MoreButton has={!!query.hasNextPage} busy={query.isFetchingNextPage} onMore={() => void query.fetchNextPage()} label={t("older")} />
    </div>
  );
}
