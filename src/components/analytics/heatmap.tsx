"use client";

import { useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AnalyticsCard, BlockError, Bone, EmptyLine, blockView } from "@/components/analytics/card";
import { ChartFrame, DataTable } from "@/components/analytics/chart-frame";
import type { CallTimesPart } from "@/lib/analytics/parts";
import { MIN_HEAT_CALLS } from "@/lib/analytics/params";
import {
  bestOfRow,
  formatCount,
  formatPercent,
  heatGrid,
  heatHasRates,
  heatRows,
  hourLabel,
  hourShort,
  weekdayName,
  type HeatCell,
  type HeatLevel,
  type HeatMetric,
} from "@/lib/analytics/view";
import type { Part } from "@/lib/home";
import { cn } from "@/lib/utils";

// Best time to call (design 1.6, 4.2, 4.3): a weekday × hour grid of Paris time, drawn with CSS (Recharts has no
// heatmap) on the one monochrome ramp: 5 fixed connect-rate bins (or the range's call-count quintiles), a hatched
// "Not enough calls" cell under 5 calls. A real grid in both orientations: role grid, a header row of columnheaders,
// then rows that start with a rowheader followed by gridcells. One tab stop (roving tabindex): arrows, Home and End move
// along a row, PageUp and PageDown to the first and last row; each cell's aria-label is its full readout, and the same
// readout shows as a tooltip on focus and hover. Desktop: a row per weekday. Phone: transposed, a row per hour (32 px
// label + 7 × 40 px columns with 2 px gaps = 326 px, 44 px rows); on touch the hour row is the target and its numbers
// show in a fixed readout line above the grid (two lines reserved, so nothing moves).

const LEVEL_CLASS: Record<Exclude<HeatLevel, "none" | "few">, string> = {
  1: "bg-[var(--chart-seq-1)]",
  2: "bg-[var(--chart-seq-2)]",
  3: "bg-[var(--chart-seq-3)]",
  4: "bg-[var(--chart-seq-4)]",
  5: "bg-[var(--chart-seq-5)]",
};
const cellClass = (level: HeatLevel) => (level === "none" ? "bg-muted" : level === "few" ? "chart-hatch" : LEVEL_CLASS[level]);

function useCellText() {
  const t = useTranslations("Analytics.heat");
  const locale = useLocale();
  return (c: HeatCell) => {
    const day = weekdayName(c.dow, locale, "long");
    const hour = hourLabel(c.hour, locale);
    if (c.calls === 0) return t("cellNone", { day, hour });
    if (c.calls < MIN_HEAT_CALLS) return t("cellFew", { day, hour, calls: c.calls });
    return t("cell", { day, hour, calls: c.calls, reached: c.reached, rate: formatPercent(c.rate ?? 0, locale) });
  };
}

type GridProps = {
  rows: { head: number; cells: HeatCell[] }[];
  columns: number[];
  orientation: "weekdays" | "hours";
  describedBy: string;
  onRow?: (head: number) => void;
};

function Grid({ rows, columns, orientation, describedBy, onRow }: GridProps) {
  const t = useTranslations("Analytics.heat");
  const locale = useLocale();
  const text = useCellText();
  const [pos, setPos] = useState<[number, number]>([0, 0]);
  const [tip, setTip] = useState<{ cell: HeatCell; x: number; y: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const cellRefs = useRef(new Map<string, HTMLDivElement>());
  const weekdays = orientation === "weekdays";
  const template = weekdays ? `48px repeat(${columns.length}, minmax(0, 1fr))` : "32px repeat(7, 40px)";
  const rowHeight = weekdays ? "h-8" : "h-11";

  const show = (cell: HeatCell, el: HTMLElement) => {
    const outer = box.current?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (!outer) return;
    setTip({ cell, x: r.left - outer.left + r.width / 2, y: r.top - outer.top });
  };
  const focusAt = (r: number, c: number) => {
    const rr = Math.max(0, Math.min(rows.length - 1, r));
    const cc = Math.max(0, Math.min(columns.length - 1, c));
    setPos([rr, cc]);
    const el = cellRefs.current.get(`${rr}-${cc}`);
    el?.focus();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const [r, c] = pos;
    const moves: Record<string, [number, number]> = {
      ArrowRight: [r, c + 1],
      ArrowLeft: [r, c - 1],
      ArrowDown: [r + 1, c],
      ArrowUp: [r - 1, c],
      Home: [r, 0],
      End: [r, columns.length - 1],
      PageUp: [0, c],
      PageDown: [rows.length - 1, c],
    };
    const next = moves[e.key];
    if (!next) return;
    e.preventDefault();
    focusAt(next[0], next[1]);
  };
  const colLabel = (v: number) => (weekdays ? hourShort(v, locale) : weekdayName(v, locale, "short"));
  const rowLabel = (v: number) => (weekdays ? weekdayName(v, locale, "short") : hourShort(v, locale));

  return (
    <div ref={box} className="relative">
      <div role="grid" aria-label={t("gridLabel")} aria-describedby={describedBy} onKeyDown={onKeyDown} className="flex flex-col gap-0.5" data-orientation={orientation}>
        <div role="row" className="grid gap-0.5" style={{ gridTemplateColumns: template }}>
          <div role="columnheader" className="text-[11px] text-muted-foreground">
            <span className="sr-only">{weekdays ? t("weekday") : t("hour")}</span>
          </div>
          {columns.map((v) => (
            <div key={v} role="columnheader" className="text-center font-mono text-[11px] leading-5 text-muted-foreground">
              {colLabel(v)}
            </div>
          ))}
        </div>
        {rows.map((row, r) => (
          <div
            key={row.head}
            role="row"
            className={cn("grid gap-0.5", onRow && "cursor-pointer")}
            style={{ gridTemplateColumns: template }}
            onClick={onRow ? () => onRow(row.head) : undefined}
            data-heat-row={row.head}
          >
            <div role="rowheader" className={cn("flex items-center font-mono text-[11px] text-muted-foreground", rowHeight)}>
              {rowLabel(row.head)}
            </div>
            {row.cells.map((cell, c) => (
              <div
                key={c}
                role="gridcell"
                ref={(el) => {
                  if (el) cellRefs.current.set(`${r}-${c}`, el);
                  else cellRefs.current.delete(`${r}-${c}`);
                }}
                tabIndex={pos[0] === r && pos[1] === c ? 0 : -1}
                aria-label={text(cell)}
                data-level={cell.level}
                onFocus={(e) => {
                  setPos([r, c]);
                  // The tooltip follows the keyboard; a tap on a phone fills the readout line instead.
                  if (e.currentTarget.matches(":focus-visible")) show(cell, e.currentTarget);
                }}
                onBlur={() => setTip(null)}
                onPointerEnter={(e) => e.pointerType === "mouse" && show(cell, e.currentTarget)}
                onPointerLeave={(e) => e.pointerType === "mouse" && setTip(null)}
                className={cn("rounded-[4px] outline-offset-1", rowHeight, cellClass(cell.level))}
              />
            ))}
          </div>
        ))}
      </div>
      {tip ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-10 w-max max-w-64 -translate-x-1/2 -translate-y-full rounded-md border border-border bg-card px-3 py-2 text-sm shadow-[0_12px_32px_rgb(14_14_16/0.14)]"
          style={{ left: tip.x, top: tip.y - 6 }}
        >
          {text(tip.cell)}
        </div>
      ) : null}
    </div>
  );
}

export function HeatmapCard({ part, loading, busy, onRetry }: { part: Part<CallTimesPart> | undefined; loading: boolean; busy: boolean; onRetry: () => void }) {
  const t = useTranslations("Analytics.heat");
  const locale = useLocale();
  const [metric, setMetric] = useState<HeatMetric>("rate");
  const [readout, setReadout] = useState<number | null>(null);
  const view = blockView(part, loading);
  const grid = useMemo(() => (view.kind === "ok" ? heatGrid(view.data, metric) : null), [view, metric]);

  const switcher =
    view.kind === "ok" && heatHasRates(view.data) ? (
      <div role="group" aria-label={t("metric")} className="inline-flex shrink-0 rounded-md bg-muted p-1">
        {(["rate", "volume"] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={metric === m}
            onClick={() => setMetric(m)}
            className={cn(
              "min-h-11 rounded-sm px-3 text-sm font-bold transition-[background-color,color,scale] duration-150 active:scale-[0.97] sm:min-h-9",
              metric === m ? "bg-pill text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(m)}
          </button>
        ))}
      </div>
    ) : null;

  let body: React.ReactNode;
  if (view.kind === "loading") body = <HeatmapSkeleton />;
  else if (view.kind === "error") body = <BlockError block={t("block")} onRetry={onRetry} />;
  else if (!heatHasRates(view.data) || !grid) body = <EmptyLine text={t("empty")} />;
  else {
    const cells = [...grid.cells.values()];
    const slot = (c: HeatCell) => t("slot", { day: weekdayName(c.dow, locale, "short"), hour: hourLabel(c.hour, locale) });
    const best = bestOfRow(cells);
    const busiest = cells.reduce<HeatCell | null>((b, c) => (c.calls > (b?.calls ?? 0) ? c : b), null);
    const caption =
      metric === "rate"
        ? best
          ? t("caption", { slot: slot(best), rate: formatPercent(best.rate ?? 0, locale), calls: best.calls })
          : t("captionFew")
        : busiest
          ? t("captionVolume", { slot: slot(busiest), calls: busiest.calls })
          : t("captionFew");
    const phoneRows = heatRows(grid, "hours");
    const readRow = readout === null ? null : phoneRows.find((r) => r.head === readout);
    const readText = (() => {
      if (!readRow) return t("tapHint");
      const calls = readRow.cells.reduce((s, c) => s + c.calls, 0);
      const reached = readRow.cells.reduce((s, c) => s + c.reached, 0);
      const hour = hourLabel(readRow.head, locale);
      if (calls === 0) return t("readoutNone", { hour });
      const top = bestOfRow(readRow.cells);
      const line = t("readout", { hour, calls, reached, rate: formatPercent(reached / calls, locale) });
      return top ? `${line} · ${t("readoutBest", { day: weekdayName(top.dow, locale, "short"), rate: formatPercent(top.rate ?? 0, locale) })}` : line;
    })();
    const withCalls = cells.filter((c) => c.calls > 0);
    body = (
      <ChartFrame
        heading={t("title")}
        caption={caption}
        footer={
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-muted-foreground" aria-hidden="true">
              <span className="inline-flex items-center gap-1.5">
                <span>{t("legendLess")}</span>
                {([1, 2, 3, 4, 5] as const).map((l) => (
                  <span key={l} className={cn("size-3 rounded-[3px]", LEVEL_CLASS[l])} />
                ))}
                <span>{t("legendMore")}</span>
              </span>
              {metric === "rate" ? (
                <span className="inline-flex items-center gap-1.5">
                  <span className="chart-hatch size-3 rounded-[3px]" />
                  <span>{t("legendFew")}</span>
                </span>
              ) : null}
            </div>
            {grid.outside > 0 ? <p className="text-[13px] text-muted-foreground">{t("outside", { count: grid.outside })}</p> : null}
          </div>
        }
        table={
          <DataTable
            caption={t("title")}
            columns={[
              { key: "slot", label: t("table.slot") },
              { key: "calls", label: t("table.calls"), numeric: true },
              { key: "reached", label: t("table.reached"), numeric: true },
              { key: "rate", label: t("table.rate"), numeric: true },
            ]}
            rows={withCalls.map((c) => ({
              key: `${c.dow}-${c.hour}`,
              cells: [
                slot(c),
                formatCount(c.calls, locale),
                formatCount(c.reached, locale),
                c.calls >= MIN_HEAT_CALLS ? formatPercent(c.rate ?? 0, locale) : t("legendFew"),
              ],
            }))}
          />
        }
      >
        {(captionId) => (
          <>
            <div className="hidden sm:block" data-heat="desktop">
              <Grid rows={heatRows(grid, "weekdays")} columns={grid.hours} orientation="weekdays" describedBy={captionId} />
            </div>
            <div className="flex flex-col gap-2 sm:hidden" data-heat="phone">
              <p role="status" className="min-h-10 text-[13px] leading-5 text-muted-foreground" data-heat-readout="">
                {readText}
              </p>
              <Grid rows={phoneRows} columns={[1, 2, 3, 4, 5, 6, 7]} orientation="hours" describedBy={captionId} onRow={setReadout} />
            </div>
          </>
        )}
      </ChartFrame>
    );
  }
  return (
    <AnalyticsCard heading={t("title")} labelId="analytics-heat" busy={busy} className="col-span-12" action={switcher}>
      {body}
    </AnalyticsCard>
  );
}

export function HeatmapSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden="true">
      <Bone className="h-5 w-3/4 max-w-96" />
      <div className="hidden flex-col gap-0.5 sm:flex">
        <Bone className="h-5 w-full" />
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <Bone key={i} className="h-8 w-full" />
        ))}
      </div>
      <div className="flex flex-col gap-0.5 sm:hidden">
        <Bone className="h-10 w-full" />
        {Array.from({ length: 14 }, (_, i) => (
          <Bone key={i} className="h-11 w-full" />
        ))}
      </div>
      <Bone className="h-11 w-36" />
    </div>
  );
}
