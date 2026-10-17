"use client";

import dynamic from "next/dynamic";
import { useId } from "react";
import { useTranslations } from "next-intl";
import { Disclosure } from "@/components/ui/disclosure";
import { cn } from "@/lib/utils";
import type { BarList as BarListType, ColumnChart as ColumnChartType } from "@/components/analytics/charts";

// The frame every Analytics chart sits in (design 4.3 "Common mechanics"): a <figure> whose <figcaption> is the card's
// title and one generated sentence, the drawing (Recharts, loaded on demand), and a "Show as table" disclosure holding a
// real <table> with the same numbers. The caption and the table are the screen-reader path (model b); the drawing's
// one focusable element points at the caption (aria-describedby).

/** The chart area's placeholder while the chart code loads: the drawing's own height, no spinner. */
function ChartLoading() {
  return <div aria-hidden="true" className="h-full w-full rounded-md bg-muted motion-safe:animate-pulse" />;
}

export const ColumnChart = dynamic(() => import("@/components/analytics/charts").then((m) => m.ColumnChart), {
  ssr: false,
  loading: ChartLoading,
}) as typeof ColumnChartType;

export const BarList = dynamic(() => import("@/components/analytics/charts").then((m) => m.BarList), {
  ssr: false,
  loading: ChartLoading,
}) as typeof BarListType;

/** A box of the chart's final height, so the lazy chunk and the drawing never move the page. */
export function ChartBox({ height, children, className }: { height?: number; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("relative w-full min-w-0", className)} style={height === undefined ? undefined : { height }}>
      {children}
    </div>
  );
}

export function ChartFrame({
  heading,
  caption,
  children,
  table,
  footer,
}: {
  heading: string;
  caption: string;
  children: (captionId: string) => React.ReactNode;
  table: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const t = useTranslations("Analytics");
  const captionId = useId();
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-3">
      <figcaption id={captionId} className="text-sm text-muted-foreground">
        <span className="sr-only">
          {heading}
          {". "}
        </span>
        {caption}
      </figcaption>
      {children(captionId)}
      {footer}
      <Disclosure summary={t("showTable")} className="border-t border-border pt-1">
        <div className="pt-2">{table}</div>
      </Disclosure>
    </figure>
  );
}

export type Column = { key: string; label: string; numeric?: boolean };
export type Row = { key: string; cells: React.ReactNode[] };

/**
 * A real table for "Show as table" and the Team block: numbers in DM Mono, right-aligned. Wider than the card on a
 * phone, it scrolls inside its own region (keyboard-reachable), never the page.
 */
export function DataTable({ caption, columns, rows, footer }: { caption: string; columns: Column[]; rows: Row[]; footer?: Row }) {
  return (
    <div role="region" aria-label={caption} tabIndex={0} className="max-w-full overflow-x-auto rounded-sm">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border">
            {columns.map((c, i) => (
              <th
                key={c.key}
                scope="col"
                className={cn(
                  "px-2 py-2 font-mono text-xs font-medium text-muted-foreground",
                  c.numeric ? "text-right" : "text-left",
                  i === 0 && "pl-0",
                )}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-border/60 last:border-b-0">
              {r.cells.map((cell, i) =>
                i === 0 ? (
                  <th key={i} scope="row" className="py-2 pr-2 text-left font-normal">
                    {cell}
                  </th>
                ) : (
                  <td key={i} className={cn("px-2 py-2", columns[i]?.numeric && "text-right font-mono tabular-nums")}>
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
        {footer ? (
          <tfoot>
            <tr className="border-t border-border font-bold">
              {footer.cells.map((cell, i) =>
                i === 0 ? (
                  <th key={i} scope="row" className="py-2 pr-2 text-left">
                    {cell}
                  </th>
                ) : (
                  <td key={i} className={cn("px-2 py-2", columns[i]?.numeric && "text-right font-mono tabular-nums")}>
                    {cell}
                  </td>
                ),
              )}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}
