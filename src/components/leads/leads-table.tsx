"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  columnVisibilityFeature,
  createColumnHelper,
  flexRender,
  rowSelectionFeature,
  tableFeatures,
  useTable,
  type ColumnVisibilityState,
  type RowSelectionState,
} from "@tanstack/react-table";
import { takeListScroll } from "@/components/lead/lead-nav";
import { StatusBadge } from "@/components/leads/status-badge";
import { countryName } from "@/lib/countries";
import { personName, type LeadRow } from "@/lib/leads";
import { cn } from "@/lib/utils";

const features = tableFeatures({ rowSelectionFeature, columnVisibilityFeature });
const helper = createColumnHelper<typeof features, LeadRow>();

// Column widths: the company column takes the spare room; the rest stay readable. The table scrolls sideways inside
// its own box when columns do not fit (the page itself never scrolls sideways).
const widths: Record<string, [min: number, track: string]> = {
  select: [44, "44px"],
  company: [220, "minmax(220px,2fr)"],
  owner: [130, "minmax(130px,1fr)"],
  status: [170, "170px"],
  phone: [160, "160px"],
  email: [200, "minmax(200px,1.3fr)"],
  last_activity: [170, "170px"],
  city: [120, "minmax(120px,1fr)"],
  country: [130, "minmax(130px,1fr)"],
};

const headerHeight = 44; // h-11 sticky column header
const wideQuery = "(min-width: 768px)";
function subscribe(cb: () => void) {
  const mq = window.matchMedia(wideQuery);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
function useWide() {
  return useSyncExternalStore(subscribe, () => window.matchMedia(wideQuery).matches, () => true);
}

export function LeadsTable({
  rows,
  total,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  activeId,
  onOpen,
  onPrefetch,
  rowSelection,
  onRowSelectionChange,
  columnVisibility,
}: {
  rows: LeadRow[];
  total: number | null;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  activeId: string | null;
  onOpen: (id: string) => void;
  onPrefetch: (id: string) => void;
  rowSelection: RowSelectionState;
  onRowSelectionChange: (next: RowSelectionState) => void;
  columnVisibility: ColumnVisibilityState;
}) {
  const t = useTranslations("Leads");
  const tCol = useTranslations("Leads.col");
  const format = useFormatter();
  const locale = useLocale();
  const wide = useWide();
  const scrollRef = useRef<HTMLDivElement>(null);

  const columns = useMemo(
    () =>
      helper.columns([
        helper.display({ id: "select", header: () => tCol("select") }),
        helper.accessor("name", {
          id: "company",
          header: () => tCol("company"),
          cell: ({ row }) => (
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-bold">{row.original.name}</span>
              <span className="truncate text-xs text-muted-foreground">{t("contacts", { count: row.original.contact_count })}</span>
            </span>
          ),
        }),
        helper.accessor((r) => personName({ first_name: r.owner_first_name, last_name: r.owner_last_name }), {
          id: "owner",
          header: () => tCol("owner"),
          cell: ({ getValue, row }) =>
            !row.original.owner_id ? (
              <span className="truncate text-muted-foreground">{t("unassigned")}</span>
            ) : getValue() ? (
              <span className="truncate">{getValue()}</span>
            ) : (
              <span className="truncate text-muted-foreground">{t("noName")}</span>
            ),
        }),
        helper.accessor("lead_status", {
          id: "status",
          header: () => tCol("status"),
          cell: ({ getValue }) => <StatusBadge status={getValue()} />,
        }),
        helper.accessor("phone", {
          id: "phone",
          header: () => tCol("phone"),
          cell: ({ getValue }) => <span className="truncate font-mono text-xs">{getValue() ?? ""}</span>,
        }),
        helper.accessor("email", {
          id: "email",
          header: () => tCol("email"),
          cell: ({ getValue }) => <span className="truncate">{getValue() ?? ""}</span>,
        }),
        helper.accessor("last_activity_at", {
          id: "last_activity",
          header: () => tCol("last_activity"),
          cell: ({ getValue }) => {
            const v = getValue();
            return v ? (
              <time dateTime={v} className="truncate">
                {format.relativeTime(new Date(v))}
              </time>
            ) : (
              <span className="text-muted-foreground">{t("never")}</span>
            );
          },
        }),
        helper.accessor("city", {
          id: "city",
          header: () => tCol("city"),
          cell: ({ getValue }) => <span className="truncate">{getValue() ?? ""}</span>,
        }),
        helper.accessor("country", {
          id: "country",
          header: () => tCol("country"),
          cell: ({ getValue }) => <span className="truncate">{countryName(getValue(), locale)}</span>,
        }),
      ]),
    [t, tCol, format, locale],
  );

  const table = useTable({
    features,
    columns,
    data: rows,
    getRowId: (r) => r.id,
    state: { rowSelection, columnVisibility },
    onRowSelectionChange: (updater) =>
      onRowSelectionChange(typeof updater === "function" ? updater(rowSelection) : updater),
    onColumnVisibilityChange: () => {},
  });

  const visible = table.getVisibleLeafColumns();
  const template = wide ? visible.map((c) => widths[c.id][1]).join(" ") : "44px minmax(0,1fr)";
  const minWidth = wide ? visible.reduce((sum, c) => sum + widths[c.id][0], 0) : 0;
  const rowHeight = wide ? 56 : 76;

  const tableRows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: tableRows.length + (hasNextPage || rows.length > 0 ? 1 : 0),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 8,
    // Measure on the next frame: the scroll box's ResizeObserver resizing the list in the same frame makes Safari report
    // "ResizeObserver loop completed with undelivered notifications" (as the timeline did; WebKit CI, PR #19).
    useAnimationFrameWithResizeObserver: true,
    // The sticky column header sits above the rows inside the same scroll box: rows start below it, and scrolling to
    // a row (arrow keys) keeps it out from under the header.
    scrollMargin: headerHeight,
    scrollPaddingStart: headerHeight,
  });
  useEffect(() => virtualizer.measure(), [rowHeight, virtualizer]);
  // Back from a lead page: the list scrolls to where it was (once; Day 4b).
  useEffect(() => {
    const y = takeListScroll(`${window.location.pathname}${window.location.search}`);
    if (y === null) return;
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: y }));
  }, []);

  // Load the next page when the last loaded row comes into view.
  const items = virtualizer.getVirtualItems();
  const lastIndex = items.length ? items[items.length - 1].index : -1;
  useEffect(() => {
    if (lastIndex >= tableRows.length - 1 && hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [lastIndex, tableRows.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const allSelected = tableRows.length > 0 && tableRows.every((r) => rowSelection[r.id]);
  const someSelected = !allSelected && tableRows.some((r) => rowSelection[r.id]);

  // Up and Down (or J and K, as on the stock list and the lead page) move between leads and open each one in the
  // preview (like a mail list).
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const index = Number(target.dataset.rowLink ?? NaN);
    if (Number.isNaN(index) || event.metaKey || event.ctrlKey || event.altKey) return;
    const step = event.key === "ArrowDown" || event.key === "j" ? 1 : event.key === "ArrowUp" || event.key === "k" ? -1 : 0;
    if (!step) return;
    const next = index + step;
    if (next < 0 || next >= tableRows.length) return;
    event.preventDefault();
    virtualizer.scrollToIndex(next, { align: "auto" });
    onOpen(tableRows[next].id);
    const focus = (tries: number) =>
      requestAnimationFrame(() => {
        const el = scrollRef.current?.querySelector<HTMLElement>(`[data-row-link="${next}"]`);
        if (el) el.focus();
        else if (tries > 0) focus(tries - 1);
      });
    focus(3);
  }

  return (
    <div
      ref={scrollRef}
      role="table"
      aria-label={t("title")}
      aria-rowcount={total ?? undefined}
      onKeyDown={onKeyDown}
      data-leads-scroll
      className="relative min-h-0 flex-1 overflow-auto overscroll-contain rounded-lg bg-card"
    >
      <div style={{ minWidth }} className="relative">
        <div
          role="row"
          aria-rowindex={1}
          style={{ gridTemplateColumns: template }}
          className="sticky top-0 z-10 grid h-11 items-center border-b border-border bg-card font-mono text-xs text-muted-foreground"
        >
          {wide ? (
            table.getHeaderGroups()[0].headers.map((h) => (
              <div key={h.id} role="columnheader" className={cn("truncate px-3", h.column.id === "select" && "grid place-items-center px-0")}>
                {h.column.id === "select" ? (
                  <Checkbox
                    label={t("selectAll")}
                    checked={allSelected}
                    indeterminate={someSelected}
                    onChange={(on) => table.toggleAllRowsSelected(on)}
                  />
                ) : (
                  flexRender(h.column.columnDef.header, h.getContext())
                )}
              </div>
            ))
          ) : (
            <>
              <div role="columnheader" className="grid place-items-center">
                <Checkbox
                  label={t("selectAll")}
                  checked={allSelected}
                  indeterminate={someSelected}
                  onChange={(on) => table.toggleAllRowsSelected(on)}
                />
              </div>
              <div role="columnheader" className="truncate px-3">
                {tCol("company")}
              </div>
            </>
          )}
        </div>

        <div style={{ height: virtualizer.getTotalSize() }} className="relative">
          {items.map((v) => {
            const row = tableRows[v.index];
            if (!row) {
              return (
                <div
                  key="tail"
                  role="row"
                  style={{ transform: `translateY(${v.start - headerHeight}px)`, height: v.size }}
                  className="absolute inset-x-0 top-0 flex items-center px-4 text-sm text-muted-foreground"
                >
                  {hasNextPage ? (
                    <span className="flex w-full items-center gap-3" aria-label={t("loadingMore")}>
                      <span className="h-4 w-1/3 rounded-sm bg-muted motion-safe:animate-pulse" />
                      <span className="h-4 w-1/5 rounded-sm bg-muted motion-safe:animate-pulse" />
                    </span>
                  ) : (
                    <span role="cell">{t("end")}</span>
                  )}
                </div>
              );
            }
            const lead = row.original;
            const active = lead.id === activeId;
            const selected = !!rowSelection[lead.id];
            return (
              <div
                key={lead.id}
                role="row"
                aria-rowindex={v.index + 2}
                aria-selected={selected}
                data-active={active || undefined}
                style={{ transform: `translateY(${v.start - headerHeight}px)`, height: v.size, gridTemplateColumns: template }}
                onMouseEnter={() => onPrefetch(lead.id)}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("input,a,button")) return;
                  onOpen(lead.id);
                }}
                className={cn(
                  "absolute inset-x-0 top-0 grid cursor-pointer items-center border-b border-border text-sm transition-colors duration-100",
                  active ? "bg-muted/60" : selected ? "bg-muted/35" : "hover:bg-muted/30 active:bg-muted/50",
                )}
              >
                {(wide ? row.getVisibleCells() : row.getVisibleCells().filter((c) => c.column.id === "select" || c.column.id === "company")).map(
                  (cell) => {
                    const id = cell.column.id;
                    if (id === "select")
                      return (
                        <div key={cell.id} role="cell" className="grid place-items-center">
                          <Checkbox label={t("selectRow", { name: lead.name })} checked={selected} onChange={(on) => row.toggleSelected(on)} />
                        </div>
                      );
                    if (id === "company")
                      return (
                        <div key={cell.id} role="cell" className="flex min-w-0 items-center px-3">
                          <a
                            href={`/leads?lead=${lead.id}`}
                            data-row-link={v.index}
                            aria-current={active || undefined}
                            onFocus={() => onPrefetch(lead.id)}
                            onClick={(e) => {
                              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                              e.preventDefault();
                              onOpen(lead.id);
                            }}
                            className="flex min-w-0 flex-1 flex-col rounded-sm focus-visible:outline-offset-2"
                          >
                            {wide ? (
                              flexRender(cell.column.columnDef.cell, cell.getContext())
                            ) : (
                              <span className="flex min-w-0 flex-col gap-1">
                                <span className="truncate font-bold">{lead.name}</span>
                                <span className="flex min-w-0 items-center gap-2">
                                  <StatusBadge status={lead.lead_status} />
                                  <span className="truncate text-xs text-muted-foreground">
                                    {lead.last_activity_at ? format.relativeTime(new Date(lead.last_activity_at)) : t("never")}
                                  </span>
                                </span>
                              </span>
                            )}
                          </a>
                        </div>
                      );
                    return (
                      <div key={cell.id} role="cell" className="flex min-w-0 items-center px-3">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </div>
                    );
                  },
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Checkbox({
  label,
  checked,
  indeterminate = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  indeterminate?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className="grid size-11 cursor-pointer place-items-center">
      <span className="sr-only">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        ref={(el) => {
          if (el) el.indeterminate = indeterminate;
        }}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 cursor-pointer accent-foreground"
      />
    </label>
  );
}
