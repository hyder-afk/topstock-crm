"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { animate } from "motion/react";
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis, useActiveTooltipLabel } from "recharts";
import { springs } from "@/lib/motion";

// The Recharts drawings of Analytics (design 4.3 to 4.5), loaded only on /analytics (next/dynamic, no server render).
// - Monochrome: every mark is a chart ink token (globals.css), never Signal Red. At rest every bar is full ink; while a
//   datum is active (pointer or keyboard) it stays full ink, the others step down to ink-65, and a cursor band sits
//   behind it. Remainders ("not reached", "Not yet") are ink-35 and do not change.
// - Screen readers, model (b): the figure's caption and its "Show as table" view are the path. Recharts'
//   accessibilityLayer makes the <svg> itself the one tab stop (role application, arrow keys move the tooltip), so the
//   svg gets the chart's aria-label and aria-describedby (the caption), and everything inside it, and the tooltip
//   beside it, is aria-hidden: nothing focusable ever sits inside aria-hidden (axe aria-hidden-focus). The mini charts
//   have no accessibility layer and are hidden whole.
// - Untrusted names (products) reach the drawing only as React text: tick and label formatters return strings.
// - Recharts' own animation is off (it animates geometry). The first-visit entrance is a Motion spring on the bar
//   groups (scaleY from the baseline, scaleX for horizontal bars), 30 ms apart per chart, never under reduced motion.

type Tone = "ink" | "ink35";
const fill = (tone: Tone, active: boolean | null) =>
  tone === "ink35" ? "var(--chart-ink-35)" : active === false ? "var(--chart-ink-65)" : "var(--chart-ink)";

const AXIS_TICK = { fill: "var(--chart-axis)", fontSize: 12, fontFamily: "var(--font-mono)" } as const;

/** Writes the active datum's key (the category under the pointer or keyboard) to the chart's state. */
function ActiveReporter({ onChange }: { onChange: (key: string | null) => void }) {
  const label = useActiveTooltipLabel();
  const key = label === undefined || label === null ? null : String(label);
  useEffect(() => onChange(key), [key, onChange]);
  return null;
}

/** aria-label and aria-describedby on the focusable svg; aria-hidden on everything inside it and beside it. */
function useScreenReaderModel(ref: React.RefObject<HTMLDivElement | null>, label: string | null, describedBy: string | undefined) {
  useEffect(() => {
    const root = ref.current;
    if (!root || label === null) return;
    const apply = () => {
      const svg = root.querySelector<SVGSVGElement>("svg.recharts-surface");
      if (svg) {
        if (svg.getAttribute("aria-label") !== label) svg.setAttribute("aria-label", label);
        if (describedBy && svg.getAttribute("aria-describedby") !== describedBy) svg.setAttribute("aria-describedby", describedBy);
        for (const child of svg.children) if (child.getAttribute("aria-hidden") !== "true") child.setAttribute("aria-hidden", "true");
      }
      // The tooltip and any other layer next to the svg (Recharts' wrapper div holds them).
      for (const el of root.querySelectorAll(".recharts-wrapper > :not(svg)")) {
        if (el.getAttribute("aria-hidden") !== "true") el.setAttribute("aria-hidden", "true");
      }
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [ref, label, describedBy]);
}

/** The first-visit entrance: the bar groups grow from their baseline once they exist, then the plot is left alone. */
function useEntrance(ref: React.RefObject<HTMLDivElement | null>, entrance: boolean, order: number, horizontal: boolean) {
  const [state, setState] = useState<"pending" | "done">(entrance ? "pending" : "done");
  useLayoutEffect(() => {
    if (state !== "pending") return;
    const root = ref.current;
    if (!root) return;
    let runs: { stop: () => void }[] = [];
    const start = () => {
      const groups = [...root.querySelectorAll<SVGGElement>(".recharts-bar-rectangles")];
      if (groups.length === 0) return false;
      runs = groups.map((g) => {
        g.style.transformBox = "fill-box";
        g.style.transformOrigin = horizontal ? "left" : "bottom";
        return animate(g, horizontal ? { scaleX: [0, 1] } : { scaleY: [0, 1] }, { ...springs.smooth, delay: order * 0.03 });
      });
      setState("done");
      return true;
    };
    if (start()) return;
    const observer = new MutationObserver(() => {
      if (start()) observer.disconnect();
    });
    observer.observe(root, { childList: true, subtree: true });
    // Nothing to draw (an empty series): stop waiting.
    const timer = setTimeout(() => {
      observer.disconnect();
      setState("done");
    }, 1500);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
      runs.forEach((r) => r.stop());
    };
  }, [ref, state, order, horizontal]);
  return state;
}

export type TooltipBody = { lead: string; lines: string[] };

function TooltipCard({ body }: { body: TooltipBody | null }) {
  if (!body) return null;
  return (
    <div aria-hidden="true" className="pointer-events-none max-w-64 rounded-md border border-border bg-card px-3 py-2 text-sm shadow-[0_12px_32px_rgb(14_14_16/0.14)]">
      <p className="font-mono font-medium text-foreground">{body.lead}</p>
      {body.lines.map((line, i) => (
        <p key={i} className="text-muted-foreground">
          {line}
        </p>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Columns over time (Calls, Revenue, and the mini charts)
// ---------------------------------------------------------------------------------------------------------------------

export type ColumnRow = { key: string; total: number; part?: number };

type ColumnChartProps<R extends ColumnRow> = {
  rows: R[];
  /** Pixels; by default the chart fills its box (the box's height is CSS, so the server's skeleton matches). */
  height?: number;
  /** null: no accessibility layer (the mini charts), hidden whole. */
  label: string | null;
  describedBy?: string;
  tickLabel: (key: string) => string;
  yTick?: (n: number) => string;
  /** The y axis' width (money ticks need more than counts). */
  yWidth?: number;
  tooltip: (row: R) => TooltipBody;
  /** "part" is the full-ink share at the bottom of each column (reached calls); the rest is ink-35. */
  split?: boolean;
  /** The bucket that carries a direct value label (the busiest), and its text. */
  direct?: { key: string; text: string } | null;
  interval?: number | "preserveStartEnd";
  axes?: boolean;
  entrance: boolean;
  order: number;
};

export function ColumnChart<R extends ColumnRow>({
  rows,
  height,
  label,
  describedBy,
  tickLabel,
  yTick,
  yWidth = 48,
  tooltip,
  split = false,
  direct = null,
  interval = "preserveStartEnd",
  axes = true,
  entrance,
  order,
}: ColumnChartProps<R>) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(null);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  useScreenReaderModel(ref, label, describedBy);
  const enter = useEntrance(ref, entrance, order, false);

  // One bar per bucket (its total); the shape draws the split, the 2 px surface gap, the 4 px rounded top and the
  // busiest bucket's label, so a zero part never leaves a stray segment.
  const shape = (props: unknown) => {
    const { x, y, width, height: h, payload } = props as { x: number; y: number; width: number; height: number; payload: R };
    if (!(h > 0) || !(width > 0)) return <g />;
    const on = active === null ? null : payload.key === active;
    const r = Math.min(4, width / 2);
    const top = (yy: number, hh: number, tone: Tone) => (
      <path
        d={`M${x},${yy + hh} L${x},${yy + r} Q${x},${yy} ${x + r},${yy} L${x + width - r},${yy} Q${x + width},${yy} ${x + width},${yy + r} L${x + width},${yy + hh} Z`}
        fill={fill(tone, on)}
      />
    );
    const flat = (yy: number, hh: number, tone: Tone) => <rect x={x} y={yy} width={width} height={hh} fill={fill(tone, on)} />;
    let marks: React.ReactNode;
    if (split && payload.total > 0) {
      const partH = (h * (payload.part ?? 0)) / payload.total;
      const restH = h - partH;
      if (restH <= 0) marks = top(y, h, "ink");
      else if (partH <= 0) marks = top(y, h, "ink35");
      else {
        const gap = Math.min(2, restH / 2);
        marks = (
          <>
            {top(y, Math.max(0, restH - gap), "ink35")}
            {flat(y + restH, partH, "ink")}
          </>
        );
      }
    } else marks = top(y, h, "ink");
    return (
      <g>
        {marks}
        {direct && direct.key === payload.key ? (
          <text x={x + width / 2} y={y - 6} textAnchor="middle" fill="var(--foreground)" fontSize={12} fontFamily="var(--font-mono)">
            {direct.text}
          </text>
        ) : null}
      </g>
    );
  };

  return (
    <div
      ref={ref}
      className="analytics-chart h-full w-full"
      data-enter={enter === "pending" ? "pending" : undefined}
      data-layout="columns"
      aria-hidden={label === null || undefined}
      style={height === undefined ? undefined : { height }}
    >
      <BarChart
        responsive
        width="100%"
        height={height ?? "100%"}
        data={rows}
        accessibilityLayer={label !== null}
        margin={{ top: direct ? 20 : 4, right: axes ? 16 : 4, bottom: 0, left: 0 }}
        barCategoryGap="20%"
      >
        {axes ? <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeWidth={1} /> : null}
        <XAxis
          dataKey="key"
          hide={!axes}
          tickFormatter={(k: string) => tickLabel(k)}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={{ stroke: "var(--chart-grid)" }}
          interval={interval}
          minTickGap={24}
          tickMargin={8}
        />
        <YAxis
          hide={!axes}
          width={yWidth}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
          tickFormatter={(n: number) => (yTick ? yTick(n) : String(n))}
        />
        <Tooltip
          isAnimationActive={false}
          cursor={{ fill: "var(--chart-cursor)" }}
          content={({ active: on, label: key }) => <TooltipCard body={on && key !== undefined && byKey.get(String(key)) ? tooltip(byKey.get(String(key))!) : null} />}
        />
        <Bar dataKey="total" isAnimationActive={false} maxBarSize={24} shape={shape} activeBar={false} />
        <ActiveReporter onChange={setActive} />
      </BarChart>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Horizontal bars (Speed-to-lead, the funnel, lost reasons, top products)
// ---------------------------------------------------------------------------------------------------------------------

export type BarRow = { key: string; label: string; value: number; tone?: Tone; tip: string };

type BarListProps = {
  rows: BarRow[];
  label: string;
  describedBy?: string;
  /** The value axis' end (the funnel's cohort, so bars read as % of it); the largest value when left out. */
  max?: number;
  /** Characters a category label keeps before it is cut (the full text is in the tooltip and the table). */
  labelChars: number;
  labelWidth: number;
  tooltip: (row: BarRow) => TooltipBody;
  entrance: boolean;
  order: number;
};

const ROW_H = 40;

export function BarList({ rows, label, describedBy, max, labelChars, labelWidth, tooltip, entrance, order }: BarListProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(null);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  useScreenReaderModel(ref, label, describedBy);
  const enter = useEntrance(ref, entrance, order, true);
  const height = rows.length * ROW_H + 8;
  const top = Math.max(1, max ?? Math.max(0, ...rows.map((r) => r.value)));
  const cut = (text: string) => {
    const chars = [...text];
    return chars.length <= labelChars ? text : `${chars.slice(0, labelChars - 1).join("").trimEnd()}…`;
  };

  const shape = (props: unknown) => {
    const { x, y, width, height: h, payload } = props as { x: number; y: number; width: number; height: number; payload: BarRow };
    const on = active === null ? null : payload.key === active;
    const w = Math.max(0, width);
    const r = Math.min(4, w / 2, h / 2);
    return (
      <g>
        {w > 0 ? (
          <path
            d={`M${x},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} L${x},${y + h} Z`}
            fill={fill(payload.tone ?? "ink", on)}
          />
        ) : null}
        <text x={x + w + 8} y={y + h / 2} dominantBaseline="central" fill="var(--foreground)" fontSize={12} fontFamily="var(--font-mono)">
          {payload.tip}
        </text>
      </g>
    );
  };

  return (
    <div ref={ref} className="analytics-chart w-full" data-enter={enter === "pending" ? "pending" : undefined} data-layout="bars" style={{ height }}>
      <BarChart responsive width="100%" height={height} data={rows} layout="vertical" margin={{ top: 4, right: 96, bottom: 4, left: 0 }} barCategoryGap={8}>
        <XAxis type="number" hide domain={[0, top]} />
        <YAxis
          type="category"
          dataKey="key"
          width={labelWidth}
          tickLine={false}
          axisLine={false}
          tick={{ fill: "var(--foreground)", fontSize: 13 }}
          tickFormatter={(k: string) => cut(byKey.get(k)?.label ?? "")}
        />
        <Tooltip
          isAnimationActive={false}
          cursor={{ fill: "var(--chart-cursor)" }}
          content={({ active: on, label: key }) => <TooltipCard body={on && key !== undefined && byKey.get(String(key)) ? tooltip(byKey.get(String(key))!) : null} />}
        />
        <Bar dataKey="value" isAnimationActive={false} maxBarSize={24} shape={shape} activeBar={false} minPointSize={0} />
        <ActiveReporter onChange={setActive} />
      </BarChart>
    </div>
  );
}
