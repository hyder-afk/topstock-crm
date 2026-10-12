"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { FileUp, Package, Plus, Receipt, Settings } from "lucide-react";
import { useStepUp } from "@/components/auth/step-up-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { TabList, TabPanel } from "@/components/ui/tabs";
import { useDisplayUnit } from "@/components/inventory/bits";
import { ProductFormDialog } from "@/components/inventory/product-form";
import { ProductPanel, type Role } from "@/components/inventory/product-panel";
import { StockTable, StockTableSkeleton } from "@/components/inventory/stock-table";
import { StockToolbar } from "@/components/inventory/stock-toolbar";
import { ArrivingList, ListState, MovementsList, ReservedList } from "@/components/inventory/tab-lists";
import { prefetchProduct, useProduct, useStock, useSummary } from "@/components/inventory/use-inventory";
import { RecordSaleSheet, type SaleLead, type SalePrefill } from "@/components/sales/record-sale-sheet";
import { HoldSheet } from "@/components/sales/hold-and-request-sheets";
import { ShareWithDialog } from "@/components/share-links/share-with-dialog";
import { RequestsList, SalesList } from "@/components/sales/sales-tabs";
import { useAlerts } from "@/components/sales/use-sales";
import {
  INVENTORY_TABS,
  parseStockFilters,
  parseTab,
  stockFiltersToParams,
  type InventoryTab,
  type StockFilters,
} from "@/lib/inventory/filters";
import { pieces as fmtPieces } from "@/lib/inventory/format";
import type { StockPage, StockSummary } from "@/lib/inventory/types";
import { cn } from "@/lib/utils";

type Member = { id: string; first_name: string | null; last_name: string | null };
type SaleType = "all" | "from_stock" | "direct_from_source";
type RequestFilter = "open" | "done" | "declined" | "all";
type UiState = {
  tab: InventoryTab;
  filters: StockFilters;
  product: string | null;
  movementsProduct: string | null;
  company: string | null;
  saleType: SaleType;
  requestStatus: RequestFilter;
};
const saleTypes: readonly string[] = ["from_stock", "direct_from_source"];
const requestFilters: readonly string[] = ["done", "declined", "all"];
const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stateFrom(params: URLSearchParams): UiState {
  const tab = parseTab(params.get("tab"));
  const product = params.get("product");
  const ok = product && uuidLike.test(product) ? product : null;
  const company = tab === "sales" ? params.get("company") : null;
  return {
    tab,
    filters: parseStockFilters(params),
    product: tab === "movements" ? null : ok,
    movementsProduct: tab === "movements" ? ok : null,
    company: company && uuidLike.test(company) ? company : null,
    // The Sales type and the Requests status chips live in the URL too (a shared link opens the same list).
    saleType: tab === "sales" && saleTypes.includes(params.get("type") ?? "") ? (params.get("type") as SaleType) : "all",
    requestStatus:
      tab === "requests" && requestFilters.includes(params.get("status") ?? "") ? (params.get("status") as RequestFilter) : "open",
  };
}
function urlFor(s: UiState) {
  const p = stockFiltersToParams(s.filters);
  if (s.tab !== "stock") p.set("tab", s.tab);
  const product = s.tab === "movements" ? s.movementsProduct : s.product;
  if (product) p.set("product", product);
  if (s.tab === "sales" && s.company) p.set("company", s.company);
  if (s.tab === "sales" && s.saleType !== "all") p.set("type", s.saleType);
  if (s.tab === "requests" && s.requestStatus !== "open") p.set("status", s.requestStatus);
  const qs = p.toString();
  return `/inventory${qs ? `?${qs}` : ""}`;
}

const xl = "(min-width: 1280px)";
const lg = "(min-width: 1024px)";
function subscribeWidth(cb: () => void) {
  const a = window.matchMedia(xl);
  const b = window.matchMedia(lg);
  a.addEventListener("change", cb);
  b.addEventListener("change", cb);
  return () => {
    a.removeEventListener("change", cb);
    b.removeEventListener("change", cb);
  };
}
function useWidthClass(): "xl" | "lg" | "sm" {
  return useSyncExternalStore(
    subscribeWidth,
    () => (window.matchMedia(xl).matches ? "xl" : window.matchMedia(lg).matches ? "lg" : "sm"),
    () => "xl",
  );
}

const URL_SHEETS = ["record", "hold", "share"] as const;

// The Inventory page (design 10.1): header (Import for admins in 6c, New product for managers and admins, Settings for
// admins, Record sale in red from 6d), the KPI row, the tabs Stock · Arriving · Reserved · Movements · Sales · Requests, and the
// product panel: beside the list from 1280 px, as a right-hand sheet from 1024 px, a full page below that. The URL keeps
// the tab, the filters and the open product (shareable, Back works).
export function InventoryWorkspace({
  initialKey,
  initialPage,
  initialSummary,
  role,
  me,
  team,
  stepUpSeconds,
}: {
  initialKey: string;
  initialPage: StockPage | null;
  initialSummary: StockSummary | null;
  role: Role;
  me: string;
  team: Member[];
  stepUpSeconds: number;
}) {
  const t = useTranslations("Inventory");
  const locale = useLocale();
  const router = useRouter();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const width = useWidthClass();
  const unit = useDisplayUnit();
  const stepUpHook = useStepUp(stepUpSeconds, "bodyStock");
  const { ensureFresh, requireFresh } = stepUpHook;
  const stepUp = useMemo(() => ({ ensureFresh, requireFresh }), [ensureFresh, requireFresh]);
  const canManage = role === "admin" || role === "manager";
  const isAdmin = role === "admin";

  const [ui, setUi] = useState(() => stateFrom(searchParams));
  const urlKey = searchParams.toString();
  const [seenKey, setSeenKey] = useState(urlKey);
  if (urlKey !== seenKey) {
    setSeenKey(urlKey);
    const fromUrl = stateFrom(searchParams);
    if (urlFor(fromUrl) !== urlFor(ui)) setUi(fromUrl);
  }
  const navigate = useCallback((next: UiState, mode: "push" | "replace") => {
    setUi(next);
    if (mode === "push") window.history.pushState(null, "", urlFor(next));
    else window.history.replaceState(null, "", urlFor(next));
  }, []);

  const summary = useSummary(initialSummary);
  const query = useStock(ui.filters, { key: initialKey, page: initialPage });
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.rows) ?? [], [query.data]);
  const total = query.data?.pages[0]?.total ?? null;
  const [adding, setAdding] = useState(false);

  const openProduct = useCallback(
    (id: string) => {
      if (width === "sm") {
        router.push(`/inventory/p/${id}`);
        return;
      }
      navigate({ ...ui, tab: ui.tab === "movements" ? "stock" : ui.tab, product: id, movementsProduct: null }, ui.product ? "replace" : "push");
    },
    [width, router, navigate, ui],
  );
  const closeProduct = useCallback(() => {
    const id = ui.product;
    navigate({ ...ui, product: null }, "replace");
    // Focus goes back to the row that opened the panel (never to the page body).
    requestAnimationFrame(() => {
      const row = id ? document.querySelector<HTMLElement>(`[data-row-link][href="/inventory/p/${id}"]`) : null;
      (row ?? document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'))?.focus();
    });
  }, [navigate, ui]);
  const intent = useRef<number | null>(null);
  const prefetch = useCallback(
    (id: string) => {
      if (intent.current !== null) window.clearTimeout(intent.current);
      intent.current = window.setTimeout(() => {
        intent.current = null;
        prefetchProduct(queryClient, id);
      }, 120);
    },
    [queryClient],
  );
  useEffect(
    () => () => {
      if (intent.current !== null) window.clearTimeout(intent.current);
    },
    [],
  );
  // Esc closes the panel (when no dialog is open: a dialog closes itself first).
  useEffect(() => {
    if (!ui.product || width !== "xl") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector("[role=dialog]")) return;
      closeProduct();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ui.product, width, closeProduct]);

  const setFilters = useCallback((filters: StockFilters) => navigate({ ...ui, filters }, "replace"), [navigate, ui]);
  const setTab = useCallback(
    (tab: InventoryTab) => navigate({ ...ui, tab, movementsProduct: tab === "movements" ? ui.movementsProduct : null, company: tab === "sales" ? ui.company : null }, "replace"),
    [navigate, ui],
  );
  // Record sale (design 10.1: the red primary of this page): from the header, a request, or Cmd+K ("?record=1"). Cmd+K
  // also opens Hold stock ("?hold=1", lead and product searched in the sheet) and Share stock with ("?share=1", a lead
  // search that opens the lead's Stock tab on the client link card).
  const [sale, setSale] = useState<{ open: boolean; lead: SaleLead | null; prefill: SalePrefill | null; key: number }>({ open: false, lead: null, prefill: null, key: 0 });
  const openSale = useCallback((lead: SaleLead | null, prefill: SalePrefill | null) => setSale((s) => ({ open: true, lead, prefill, key: s.key + 1 })), []);
  const [holding, setHolding] = useState(false);
  const [sharing, setSharing] = useState(false);
  const wants = URL_SHEETS.find((k) => searchParams.get(k) === "1") ?? null;
  const [wantsSeen, setWantsSeen] = useState<string | null>(null);
  if (wants !== wantsSeen) {
    setWantsSeen(wants);
    if (wants === "record") setSale((x) => ({ open: true, lead: null, prefill: null, key: x.key + 1 }));
    else if (wants === "hold") setHolding(true);
    else if (wants === "share") setSharing(true);
  }
  useEffect(() => {
    if (!wants) return;
    const url = new URL(window.location.href);
    for (const k of URL_SHEETS) url.searchParams.delete(k);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
  }, [wants]);
  const alerts = useAlerts();
  const movementsProduct = useProduct(ui.movementsProduct);

  const s = summary.data;
  const filtered = !!(ui.filters.q || ui.filters.category || (ui.filters.filter && ui.filters.filter !== "all"));
  let stockBody: React.ReactNode;
  if (query.isPending) stockBody = <StockTableSkeleton />;
  else if (query.isError && rows.length === 0) stockBody = <ListState kind="error" title={t("errorTitle")} body={t("errorBody")} onRetry={() => void query.refetch()} />;
  else if (rows.length === 0)
    stockBody = filtered ? (
      <div className="flex flex-col items-start gap-3 rounded-lg bg-card p-6 sm:p-8">
        <h2 className="text-xl font-bold">{t("noMatchTitle")}</h2>
        <p className="text-muted-foreground">{t("noMatchBody")}</p>
        <Button variant="quiet" onClick={() => setFilters({ sort: ui.filters.sort })}>
          {t("clearFilters")}
        </Button>
      </div>
    ) : (
      <div className="flex flex-col items-start gap-3 rounded-lg bg-card p-6 sm:p-8">
        <span className="grid size-11 place-items-center rounded-md bg-muted text-muted-foreground">
          <Package aria-hidden="true" strokeWidth={1.75} className="size-[22px]" />
        </span>
        <h2 className="text-xl font-bold">{t("emptyTitle")}</h2>
        <p className="max-w-[60ch] text-muted-foreground">{canManage ? t("emptyBody") : t("emptyBodyRep")}</p>
        {canManage ? (
          <Button variant="quiet" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" strokeWidth={2} className="size-4" />
            {t("newProduct")}
          </Button>
        ) : null}
      </div>
    );
  else
    stockBody = (
      <StockTable
        rows={rows}
        total={total}
        hasNextPage={query.hasNextPage}
        isFetchingNextPage={query.isFetchingNextPage}
        fetchNextPage={() => void query.fetchNextPage()}
        activeId={ui.product}
        onOpen={openProduct}
        onPrefetch={prefetch}
        showCost={canManage}
        unit={unit}
      />
    );

  const tabs = INVENTORY_TABS.map((id) => ({
    id,
    label:
      id === "requests" && alerts.data && alerts.data.requests_new > 0 ? (
        <span className="inline-flex items-center gap-1.5">
          {t(`tabs.${id}`)}
          <span className="rounded-full bg-muted px-1.5 font-mono text-xs text-foreground" aria-label={t("newRequests", { count: alerts.data.requests_new })}>
            {fmtPieces(locale, alerts.data.requests_new)}
          </span>
        </span>
      ) : id === "arriving" && s && s.arriving > 0 ? (
        <span className="inline-flex items-center gap-1.5">
          {t(`tabs.${id}`)}
          <span className="font-mono text-xs text-muted-foreground">{fmtPieces(locale, s.arriving)}</span>
        </span>
      ) : (
        t(`tabs.${id}`)
      ),
  }));
  const panelOpen = !!ui.product && width === "xl";

  return (
    <div className="flex flex-col gap-4 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-baseline gap-3 text-3xl font-bold sm:text-4xl">
          {t("title")}
          {s ? <span className="font-mono text-base font-normal text-muted-foreground">{t("productsCount", { count: s.products })}</span> : null}
        </h1>
        <div className="flex items-center gap-2">
          {isAdmin ? (
            <Link href="/inventory/import" className={buttonVariants({ variant: "quiet" })} aria-label={t("importSheet")}>
              <FileUp aria-hidden="true" strokeWidth={1.75} className="size-4" />
              <span className="hidden sm:inline">{t("importSheet")}</span>
            </Link>
          ) : null}
          {isAdmin ? (
            <Link href="/inventory/settings" className={buttonVariants({ variant: "quiet" })} aria-label={t("settings")}>
              <Settings aria-hidden="true" strokeWidth={1.75} className="size-4" />
              <span className="hidden sm:inline">{t("settings")}</span>
            </Link>
          ) : null}
          {canManage ? (
            <Button variant="quiet" onClick={() => setAdding(true)} aria-label={t("newProduct")}>
              <Plus aria-hidden="true" strokeWidth={2} className="size-4" />
              <span className="hidden sm:inline">{t("newProduct")}</span>
            </Button>
          ) : null}
          <Button variant="brand" onClick={() => openSale(null, null)} aria-label={t("recordSale")} className="whitespace-nowrap">
            <Receipt aria-hidden="true" strokeWidth={1.75} className="size-4" />
            <span className="sm:hidden">{t("recordSaleShort")}</span>
            <span className="hidden sm:inline">{t("recordSale")}</span>
          </Button>
        </div>
      </div>

      <KpiRow summary={s} />

      <TabList items={tabs} value={ui.tab} onChange={setTab} label={t("tabsLabel")} idBase="inventory" />

      <div className={cn("grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4", panelOpen && "xl:grid-cols-[minmax(0,1fr)_minmax(380px,420px)]")}>
        <div className="min-w-0">
          {ui.tab === "stock" ? (
            <TabPanel idBase="inventory" id="stock" className="flex min-w-0 flex-col gap-3">
              <StockToolbar filters={ui.filters} onChange={setFilters} summary={s} isAdmin={isAdmin} unit={unit} />
              <div className="flex h-[calc(100dvh-72px-144px-120px)] min-h-[440px] flex-col">{stockBody}</div>
            </TabPanel>
          ) : ui.tab === "arriving" ? (
            <TabPanel idBase="inventory" id="arriving" className="flex min-w-0 flex-col gap-3">
              <ArrivingList canManage={canManage} stepUp={stepUp} onOpen={openProduct} />
            </TabPanel>
          ) : ui.tab === "reserved" ? (
            <TabPanel idBase="inventory" id="reserved" className="flex min-w-0 flex-col gap-3">
              <ReservedList me={me} canManage={canManage} onOpen={openProduct} />
            </TabPanel>
          ) : ui.tab === "sales" ? (
            <TabPanel idBase="inventory" id="sales" className="flex min-w-0 flex-col gap-3">
              <SalesList canManage={canManage} stepUp={stepUp} company={ui.company}
                onClearCompany={() => navigate({ ...ui, company: null }, "replace")}
                type={ui.saleType}
                onType={(saleType) => navigate({ ...ui, saleType }, "replace")}
              />
            </TabPanel>
          ) : ui.tab === "requests" ? (
            <TabPanel idBase="inventory" id="requests" className="flex min-w-0 flex-col gap-3">
              <RequestsList onRecordSale={openSale} status={ui.requestStatus} onStatus={(requestStatus) => navigate({ ...ui, requestStatus }, "replace")} />
            </TabPanel>
          ) : (
            <TabPanel idBase="inventory" id="movements" className="flex min-w-0 flex-col gap-3">
              <MovementsList
                team={team}
                product={ui.movementsProduct}
                productName={movementsProduct.data?.name ?? null}
                onClearProduct={() => navigate({ ...ui, movementsProduct: null }, "replace")}
                onOpen={openProduct}
              />
            </TabPanel>
          )}
        </div>
        {panelOpen && ui.product ? (
          <aside aria-label={t("panelLabel")} className="min-w-0 self-start rounded-lg bg-card p-5 xl:sticky xl:top-4 xl:max-h-[calc(100dvh-32px)] xl:overflow-y-auto xl:overscroll-contain">
            <div key={ui.product} className="animate-panel">
              <ProductPanel id={ui.product} role={role} me={me} stepUp={stepUp} onClose={closeProduct} />
            </div>
          </aside>
        ) : null}
      </div>

      {/* 1024 to 1279 px: the panel as a right-hand sheet over the list. */}
      <Dialog open={!!ui.product && width === "lg"} onOpenChange={(o) => !o && closeProduct()}>
        <DialogContent className="side-sheet top-0 right-0 bottom-0 left-auto mx-0 h-dvh w-[min(440px,100%)] max-w-none overflow-y-auto overscroll-contain rounded-none rounded-l-xl border-y-0 border-r-0 p-5">
          <DialogTitle className="sr-only">{t("panelLabel")}</DialogTitle>
          <DialogDescription className="sr-only">{t("panelBody")}</DialogDescription>
          {ui.product ? <ProductPanel key={ui.product} id={ui.product} role={role} me={me} stepUp={stepUp} onClose={closeProduct} /> : null}
        </DialogContent>
      </Dialog>

      {canManage ? (
        <ProductFormDialog open={adding} onOpenChange={setAdding} product={null} stepUp={stepUp} onCreated={(id) => openProduct(id)} />
      ) : null}
      <RecordSaleSheet
        key={sale.key}
        open={sale.open}
        onOpenChange={(open) => setSale((x) => ({ ...x, open }))}
        lead={sale.lead}
        prefill={sale.prefill}
        canSellBelowMin={canManage}
      />
      <HoldSheet open={holding} onOpenChange={setHolding} lead={null} />
      <ShareWithDialog open={sharing} onOpenChange={setSharing} />
      {stepUpHook.dialog}
    </div>
  );
}

function KpiRow({ summary }: { summary: StockSummary | undefined }) {
  const t = useTranslations("Inventory.kpi");
  const locale = useLocale();
  const tiles: { key: string; label: string; value: number | undefined; unit: string }[] = [
    { key: "wh", label: t("warehouse"), value: summary?.wh_pieces, unit: t("pcs") },
    { key: "tr", label: t("transit"), value: summary?.tr_pieces, unit: t("pcs") },
    { key: "held", label: t("held"), value: summary?.held_pieces, unit: t("pcs") },
    { key: "low", label: t("low"), value: summary?.low, unit: t("products") },
  ];
  return (
    <dl className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
      {tiles.map((tile) => (
        <div key={tile.key} className="flex min-w-0 flex-col gap-1 rounded-lg bg-card p-4">
          <dt className="truncate text-sm text-muted-foreground">{tile.label}</dt>
          <dd className="flex items-baseline gap-1.5">
            {tile.value === undefined ? (
              <span aria-hidden="true" className="h-8 w-20 rounded-sm bg-muted motion-safe:animate-pulse" />
            ) : (
              <>
                <span className="font-mono text-2xl leading-tight tabular-nums sm:text-3xl">{fmtPieces(locale, tile.value)}</span>
                <span className="text-xs text-muted-foreground">{tile.unit}</span>
              </>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function KpiSkeleton() {
  return (
    <div aria-hidden="true" className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-lg bg-card p-4">
          <div className="h-5 w-24 rounded-sm bg-muted motion-safe:animate-pulse" />
          <div className="h-8 w-20 rounded-sm bg-muted motion-safe:animate-pulse sm:h-9" />
        </div>
      ))}
    </div>
  );
}
