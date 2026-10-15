"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Eye, EyeOff, Hand, PackagePlus, Pencil, Receipt, SlidersHorizontal, Truck, X } from "lucide-react";
import { archiveProduct, restoreProduct, setProductVisibility } from "@/app/(app)/inventory/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, phoneSheet } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { useToast } from "@/components/ui/toast";
import { Figure, StockStatusBadge, useQtyText } from "@/components/inventory/bits";
import { movementDelta, useMovementText } from "@/components/inventory/movement-text";
import { ProductFormDialog } from "@/components/inventory/product-form";
import { ArrivedDialog, StockChangeDialog } from "@/components/inventory/stock-dialogs";
import { runWithStepUp, useStockErrorText, type StepUp } from "@/components/inventory/stock-actions";
import { refreshInventory, useProduct } from "@/components/inventory/use-inventory";
import { useReleaseHold } from "@/components/inventory/use-hold-actions";
import { HoldSheet } from "@/components/sales/hold-and-request-sheets";
import { RecordSaleSheet } from "@/components/sales/record-sale-sheet";
import { pieces as fmtPieces, priceRange, pricePerPiece } from "@/lib/inventory/format";
import { productRef, weekStart } from "@/lib/inventory/status";
import type { ProductDetail } from "@/lib/inventory/types";
import { pallets } from "@/lib/inventory/units";
import { isTyping } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

export type Role = "admin" | "manager" | "rep";
type Dialogs = "edit" | "correct" | "receive" | "arrived" | "archive" | null;

// The product panel (design 10.1): name, category and status; a number grid (warehouse available / on hand / held,
// transit and its week, pieces per carton, pallets, price range, cost for managers and admins, reorder point); Record
// sale (S) and Hold (R) for everyone, each opening its sheet with this product and the lead search; actions for managers
// and admins (Arrived A, Correct stock, Receive, Edit E, Hide from clients, Archive, Restore); then its holds and recent
// movements.
// On desktop it sits beside the table (split view); on phones it is the full page /inventory/p/<id>.
export function ProductPanel({
  id,
  role,
  me,
  stepUp,
  onClose,
  initial,
  asPage = false,
}: {
  id: string;
  role: Role;
  me: string;
  stepUp: StepUp;
  onClose?: () => void;
  initial?: ProductDetail | null;
  asPage?: boolean;
}) {
  const t = useTranslations("Inventory.panel");
  const query = useProduct(id, initial);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [sheet, setSheet] = useState<{ kind: "sale" | "hold" | null; key: number }>({ kind: null, key: 0 });
  const openSheet = (kind: "sale" | "hold") => setSheet((x) => ({ kind, key: x.key + 1 }));
  const canManage = role === "admin" || role === "manager";
  const p = query.data;

  // S, R, A and E on an open product (quiet while typing, in a dialog, or with a modifier).
  useEffect(() => {
    if (!p || p.archived) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (document.querySelector("[role=dialog]")) return;
      if (e.key === "s" || e.key === "r") {
        e.preventDefault();
        setSheet((x) => ({ kind: e.key === "s" ? "sale" : "hold", key: x.key + 1 }));
        return;
      }
      if (!canManage) return;
      if (e.key === "a" && p.tr_on_hand > 0) {
        e.preventDefault();
        setDialog("arrived");
      } else if (e.key === "e") {
        e.preventDefault();
        setDialog("edit");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p, canManage]);

  if (query.isPending) return <PanelSkeleton />;
  if (query.isError && !p) {
    return (
      <div role="alert" className="flex flex-col items-start gap-3">
        <p className="font-bold">{t("error")}</p>
        <Button variant="quiet" onClick={() => void query.refetch()}>
          {t("retry")}
        </Button>
      </div>
    );
  }
  if (!p) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="font-bold">{t("missing")}</p>
        {onClose ? (
          <Button variant="quiet" onClick={onClose}>
            {t("close")}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PanelHeader p={p} onClose={onClose} asPage={asPage} />
      <NumberGrid p={p} canManage={canManage} />
      {!p.archived ? <SellHoldActions onSheet={openSheet} /> : null}
      {canManage ? <PanelActions p={p} role={role} stepUp={stepUp} onDialog={setDialog} /> : null}
      <HoldsSection p={p} me={me} canManage={canManage} />
      <RecentMovements p={p} />
      <RecordSaleSheet
        key={`sale-${sheet.key}`}
        open={sheet.kind === "sale"}
        onOpenChange={(o) => setSheet((x) => ({ ...x, kind: o ? "sale" : null }))}
        lead={null}
        prefill={{ lines: [{ product: p, pieces: 0 }] }}
        canSellBelowMin={canManage}
      />
      <HoldSheet open={sheet.kind === "hold"} onOpenChange={(o) => setSheet((x) => ({ ...x, kind: o ? "hold" : null }))} lead={null} product={p} />
      {canManage ? (
        <>
          <ProductFormDialog open={dialog === "edit"} onOpenChange={(o) => setDialog(o ? "edit" : null)} product={p} stepUp={stepUp} />
          <StockChangeDialog open={dialog === "correct"} onOpenChange={(o) => setDialog(o ? "correct" : null)} product={p} kind="correct" stepUp={stepUp} />
          <StockChangeDialog open={dialog === "receive"} onOpenChange={(o) => setDialog(o ? "receive" : null)} product={p} kind="receive" stepUp={stepUp} />
          <ArrivedDialog open={dialog === "arrived"} onOpenChange={(o) => setDialog(o ? "arrived" : null)} product={p} stepUp={stepUp} />
          <ArchiveDialog open={dialog === "archive"} onOpenChange={(o) => setDialog(o ? "archive" : null)} p={p} stepUp={stepUp} onArchived={onClose} />
        </>
      ) : null}
    </div>
  );
}

function PanelHeader({ p, onClose, asPage }: { p: ProductDetail; onClose?: () => void; asPage: boolean }) {
  const t = useTranslations("Inventory.panel");
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-2">
        {asPage ? (
          <h1 className="text-2xl font-bold break-words sm:text-3xl" dir="auto">
            {p.name}
          </h1>
        ) : (
          <h2 className="text-xl font-bold break-words" dir="auto" tabIndex={-1} data-panel-title>
            {p.name}
          </h2>
        )}
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span className="font-mono" translate="no">{productRef(p.number)}</span>
          {p.category ? <span dir="auto">· {p.category}</span> : null}
          <StockStatusBadge status={p.status_key} />
          {!p.share_visible ? (
            <span className="inline-flex items-center gap-1 rounded-sm bg-muted px-2 py-0.5 text-xs text-foreground">
              <EyeOff aria-hidden="true" strokeWidth={1.75} className="size-3.5" />
              {t("hidden")}
            </span>
          ) : null}
        </div>
      </div>
      {onClose && !asPage ? (
        <button
          type="button"
          onClick={onClose}
          aria-label={t("close")}
          className="grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground transition-[color,transform] duration-150 hover:text-foreground active:scale-[0.97] sm:size-9"
        >
          <X aria-hidden="true" strokeWidth={1.75} className="size-5" />
        </button>
      ) : null}
    </div>
  );
}

function NumberGrid({ p, canManage }: { p: ProductDetail; canManage: boolean }) {
  const t = useTranslations("Inventory.panel");
  const locale = useLocale();
  const format = useFormatter();
  const qty = useQtyText();
  const ppc = p.pieces_per_carton;
  const pal = pallets(p.wh_on_hand, ppc, p.cartons_per_pallet);
  return (
    <dl className="grid grid-cols-2 gap-2">
      <Figure label={t("whAvailable")} value={fmtPieces(locale, p.wh_available)} sub={qty(p.wh_available, ppc, "carton")} />
      <Figure label={t("whOnHand")} value={fmtPieces(locale, p.wh_on_hand)} sub={t("heldN", { n: fmtPieces(locale, p.wh_reserved) })} />
      <Figure
        label={t("transit")}
        value={fmtPieces(locale, p.tr_on_hand)}
        sub={
          p.tr_on_hand > 0
            ? p.transit_eta
              ? t("week", { date: format.dateTime(new Date(`${weekStart(p.transit_eta)}T12:00:00Z`), { day: "numeric", month: "short", timeZone: "UTC" }) })
              : t("noEta")
            : undefined
        }
      />
      <Figure label={t("carton")} value={fmtPieces(locale, ppc)} sub={pal !== null ? t("pallets", { n: format.number(pal, { maximumFractionDigits: 1 }) }) : undefined} />
      <Figure label={t("price")} value={priceRange(locale, p.price_min, p.price_max) ?? t("noPrice")} sub={t("exVat")} />
      {canManage ? (
        <Figure label={t("cost")} value={p.cost_per_piece !== null ? pricePerPiece(locale, p.cost_per_piece) : t("noCost")} />
      ) : null}
      <Figure label={t("reorder")} value={p.reorder_point !== null ? fmtPieces(locale, p.reorder_point) : t("noReorder")} />
    </dl>
  );
}

function SellHoldActions({ onSheet }: { onSheet: (kind: "sale" | "hold") => void }) {
  const t = useTranslations("Inventory.panel");
  const action = "min-h-11 justify-start gap-2 px-3 text-sm sm:min-h-10";
  return (
    <div className="grid grid-cols-2 gap-2">
      {/* Quiet: the page's Record sale is the red one in the header, and Arrived stays the panel's filled action. */}
      <Button variant="quiet" className={action} aria-keyshortcuts="S" onClick={() => onSheet("sale")}>
        <Receipt aria-hidden="true" strokeWidth={1.75} className="size-4" />
        <span className="flex-1 text-left">{t("recordSale")}</span>
        <Kbd aria-hidden="true" className="hidden lg:inline-grid">S</Kbd>
      </Button>
      <Button variant="quiet" className={action} aria-keyshortcuts="R" onClick={() => onSheet("hold")}>
        <Hand aria-hidden="true" strokeWidth={1.75} className="size-4" />
        <span className="flex-1 text-left">{t("hold")}</span>
        <Kbd aria-hidden="true" className="hidden lg:inline-grid">R</Kbd>
      </Button>
    </div>
  );
}

function PanelActions({ p, role, stepUp, onDialog }: { p: ProductDetail; role: Role; stepUp: StepUp; onDialog: (d: Dialogs) => void }) {
  const t = useTranslations("Inventory.panel");
  const archiveWhy = useId();
  const toast = useToast();
  const errorText = useStockErrorText();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const empty = p.wh_on_hand === 0 && p.tr_on_hand === 0 && p.wh_reserved === 0 && p.tr_reserved === 0;

  if (p.archived) {
    return role === "admin" ? (
      <div className="flex flex-wrap gap-2">
        <Button
          variant="quiet"
          aria-disabled={busy || undefined}
          onClick={async () => {
            if (busy || !(await stepUp.ensureFresh(60))) return;
            setBusy(true);
            const res = await runWithStepUp(stepUp, () => restoreProduct(p.id));
            setBusy(false);
            if (!res) return;
            refreshInventory(queryClient, p.id);
            toast.show(res.ok ? t("restored") : errorText(res));
          }}
        >
          <ArchiveRestore aria-hidden="true" strokeWidth={1.75} className="size-4" />
          {t("restore")}
        </Button>
      </div>
    ) : (
      <p className="text-sm text-muted-foreground">{t("archivedNote")}</p>
    );
  }
  const action = "min-h-11 justify-start gap-2 px-3 text-sm sm:min-h-10";
  return (
    <div className="grid grid-cols-2 gap-2">
      {p.tr_on_hand > 0 ? (
        <Button variant="neutral" className={action} onClick={() => onDialog("arrived")}>
          <Truck aria-hidden="true" strokeWidth={1.75} className="size-4" />
          <span className="flex-1 text-left">{t("arrived")}</span>
          <Kbd className="hidden border-transparent bg-transparent text-current opacity-70 lg:inline-grid">A</Kbd>
        </Button>
      ) : null}
      <Button variant="quiet" className={action} onClick={() => onDialog("correct")}>
        <SlidersHorizontal aria-hidden="true" strokeWidth={1.75} className="size-4" />
        <span className="flex-1 text-left">{t("correct")}</span>
      </Button>
      <Button variant="quiet" className={action} onClick={() => onDialog("receive")}>
        <PackagePlus aria-hidden="true" strokeWidth={1.75} className="size-4" />
        <span className="flex-1 text-left">{t("receive")}</span>
      </Button>
      <Button variant="quiet" className={action} onClick={() => onDialog("edit")}>
        <Pencil aria-hidden="true" strokeWidth={1.75} className="size-4" />
        <span className="flex-1 text-left">{t("edit")}</span>
        <Kbd className="hidden lg:inline-grid">E</Kbd>
      </Button>
      <Button
        variant="quiet"
        className={action}
        aria-pressed={!p.share_visible}
        aria-disabled={busy || undefined}
        onClick={async () => {
          if (busy) return;
          setBusy(true);
          const res = await setProductVisibility({ productId: p.id, visible: !p.share_visible }).catch(() => null);
          setBusy(false);
          refreshInventory(queryClient, p.id);
          toast.show(!res ? t("failed") : res.ok ? (p.share_visible ? t("nowHidden") : t("nowShown")) : errorText(res));
        }}
      >
        {p.share_visible ? <EyeOff aria-hidden="true" strokeWidth={1.75} className="size-4" /> : <Eye aria-hidden="true" strokeWidth={1.75} className="size-4" />}
        <span className="flex-1 text-left">{p.share_visible ? t("hide") : t("show")}</span>
      </Button>
      <Button
        variant="quiet"
        className={action}
        aria-disabled={!empty || undefined}
        aria-describedby={!empty ? archiveWhy : undefined}
        onClick={() => (empty ? onDialog("archive") : toast.show(t("archiveNeedsEmpty")))}
      >
        <Archive aria-hidden="true" strokeWidth={1.75} className="size-4" />
        <span className="flex-1 text-left">{t("archive")}</span>
      </Button>
      {/* Why Archive is not available: visible text, never a tooltip (phones show none; Day 7b). */}
      {!empty ? (
        <p id={archiveWhy} className="col-span-2 text-xs text-muted-foreground">
          {t("archiveNeedsEmpty")}
        </p>
      ) : null}
    </div>
  );
}

function ArchiveDialog({ open, onOpenChange, p, stepUp, onArchived }: { open: boolean; onOpenChange: (o: boolean) => void; p: ProductDetail; stepUp: StepUp; onArchived?: () => void }) {
  const t = useTranslations("Inventory.panel");
  const toast = useToast();
  const errorText = useStockErrorText();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className={cn(phoneSheet, "sm:w-[min(440px,calc(100%-32px))]")}>
        <div className="flex flex-col gap-5 p-6">
          <div className="flex flex-col gap-2">
            <DialogTitle className="text-xl font-bold">{t("archiveTitle")}</DialogTitle>
            <DialogDescription className="text-muted-foreground">{t("archiveBody", { name: p.name })}</DialogDescription>
          </div>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="quiet" onClick={() => onOpenChange(false)} disabled={busy}>
              {t("cancel")}
            </Button>
            <Button
              variant="neutral"
              aria-disabled={busy || undefined}
              onClick={async () => {
                if (busy || !(await stepUp.ensureFresh(60))) return;
                setBusy(true);
                const res = await runWithStepUp(stepUp, () => archiveProduct(p.id));
                setBusy(false);
                if (!res) return;
                refreshInventory(queryClient, p.id);
                onOpenChange(false);
                toast.show(res.ok ? t("archived") : errorText(res));
                if (res.ok) onArchived?.();
              }}
            >
              {busy ? t("saving") : t("archiveConfirm")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function HoldsSection({ p, me, canManage }: { p: ProductDetail; me: string; canManage: boolean }) {
  const t = useTranslations("Inventory.panel");
  const tPlace = useTranslations("Inventory.place");
  const format = useFormatter();
  const qty = useQtyText();
  const release = useReleaseHold();
  const [busyId, setBusyId] = useState<string | null>(null);
  return (
    <section aria-labelledby={`holds-${p.id}`} className="flex flex-col gap-2">
      <h3 id={`holds-${p.id}`} className="text-sm font-bold text-muted-foreground">
        {t("holds")}
      </h3>
      {p.holds.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noHolds")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {p.holds.map((h) => (
            <li key={h.id} className="flex items-center justify-between gap-3 p-3 text-sm">
              <span className="flex min-w-0 flex-col gap-0.5">
                <Link href={`/leads/${h.company_id}?tab=stock`} className="flex min-h-11 items-center truncate font-bold underline-offset-4 hover:underline sm:min-h-0" dir="auto">
                  {h.company_name}
                </Link>
                <span className="truncate text-xs text-muted-foreground">
                  {tPlace(h.location)} ·{" "}
                  {h.ended ? (
                    <span className="text-status-amber">{t("ended")}</span>
                  ) : (
                    t("until", { date: format.dateTime(new Date(`${h.hold_until}T12:00:00Z`), { day: "numeric", month: "short", timeZone: "UTC" }) })
                  )}
                  {h.deal_id ? ` · ${t("deal")}` : ""}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="font-mono">{qty(h.remaining, p.pieces_per_carton)}</span>
                {canManage || h.created_by === me ? (
                  <Button
                    variant="quiet"
                    className="min-h-11 px-3 text-sm sm:min-h-9"
                    aria-disabled={busyId === h.id || undefined}
                    aria-label={t("releaseOf", { name: h.company_name ?? "" })}
                    onClick={async () => {
                      if (busyId) return;
                      setBusyId(h.id);
                      await release(h, p.id);
                      setBusyId(null);
                    }}
                  >
                    {t("release")}
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentMovements({ p }: { p: ProductDetail }) {
  const t = useTranslations("Inventory.panel");
  const tPlace = useTranslations("Inventory.place");
  const format = useFormatter();
  const locale = useLocale();
  const say = useMovementText();
  const rows = p.movements.filter((m) => m.kind !== "transfer_out").slice(0, 10);
  return (
    <section aria-labelledby={`moves-${p.id}`} className="flex flex-col gap-2">
      <h3 id={`moves-${p.id}`} className="text-sm font-bold text-muted-foreground">
        {t("recent")}
      </h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noMovements")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {rows.map((m) => {
            const d = movementDelta(m);
            return (
              <li key={m.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate font-bold">{say(m)}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    <time dateTime={m.created_at}>
                      {format.relativeTime(new Date(m.created_at))}<span className="sr-only"> ({format.dateTime(new Date(m.created_at), { dateStyle: "medium", timeStyle: "short" })})</span>
                    </time>
                    {" · "}
                    {m.kind === "transfer_in" ? t("toWarehouse") : tPlace(m.location)}
                    {m.user_first_name ? ` · ${m.user_first_name}` : ""}
                  </span>
                </span>
                <span className={cn("shrink-0 font-mono", d.held && "text-muted-foreground")}>
                  {d.value > 0 ? "+" : "−"}
                  {fmtPieces(locale, Math.abs(d.value))}
                  {d.held ? ` ${t("heldShort")}` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <Link href={`/inventory?tab=movements&product=${p.id}`} className="inline-flex min-h-11 items-center self-start text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline sm:min-h-9">
        {t("allMovements")}
      </Link>
    </section>
  );
}

export function PanelSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="h-7 w-2/3 rounded-sm bg-muted motion-safe:animate-pulse" />
        <div className="h-5 w-1/2 rounded-sm bg-muted motion-safe:animate-pulse" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-[76px] rounded-md bg-muted motion-safe:animate-pulse" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-11 rounded-md bg-muted motion-safe:animate-pulse" />
        ))}
      </div>
      <div className="h-24 rounded-md bg-muted motion-safe:animate-pulse" />
    </div>
  );
}

