"use client";

import { useContext, useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import { FirstVisitContext, prefersReducedMotion } from "@/components/home/count-up";
import { AnalyticsCard, BlockError, Bone, EmptyLine, blockView, useNarrow } from "@/components/analytics/card";
import { BarList, ChartBox, ChartFrame, ColumnChart, DataTable, type Row } from "@/components/analytics/chart-frame";
import type { BarRow, TooltipBody } from "@/components/analytics/charts";
import type { ActivityPart, PipelinePart, SalesPart, SpeedPart } from "@/lib/analytics/parts";
import type { Bucket } from "@/lib/analytics/params";
import {
  NO_FIGURE,
  activityEmpty,
  bucketDate,
  bucketDay,
  busiest,
  callsRows,
  duration,
  formatCompact,
  formatCount,
  formatDays,
  formatMoneyCompact,
  formatPercent,
  funnelRows,
  lostRows,
  pipelineEmpty,
  productRows,
  ratio,
  revenueRows,
  speedRows,
  stageDays,
  tickInterval,
  type CallsRow,
} from "@/lib/analytics/view";
import type { Part } from "@/lib/home";
import { formatMoney } from "@/lib/money";

// The "This period" chart cards (design 4.1, 4.3, 4.7): Calls with the Emails / WhatsApp / Meetings small multiples,
// Speed-to-lead, the deal funnel with days in stage, lost reasons, revenue and top products. Each one has its skeleton
// (only while its view has no figures yet), its empty line, its error with Try again, and a "Show as table" view that
// holds exactly the numbers the chart draws.

type BlockProps<T> = { part: Part<T> | undefined; loading: boolean; busy: boolean; onRetry: () => void };

/** Entrance on the first view of Analytics in this tab, never under reduced motion. */
function useEntrance(): boolean {
  const first = useContext(FirstVisitContext);
  return first && typeof window !== "undefined" && !prefersReducedMotion();
}

/** "Tue 14 Oct", or "Week of 6 Oct (partial week)". */
function useBucketName(bucket: Bucket) {
  const t = useTranslations("Analytics");
  const locale = useLocale();
  return (start: string, partial: boolean) =>
    bucket === "day"
      ? bucketDay(start, locale)
      : `${t("weekOf", { date: bucketDate(start, locale) })}${partial ? ` (${t("partialWeek")})` : ""}`;
}

function percentOrDash(x: number | null, locale: string) {
  return x === null ? NO_FIGURE : formatPercent(x, locale);
}

export function ChartSkeleton({ legend = false, minis = false, bars }: { legend?: boolean; minis?: boolean; bars?: number }) {
  return (
    <div className="flex flex-col gap-3" aria-hidden="true">
      <Bone className="h-5 w-3/4 max-w-96" />
      {legend ? <Bone className="h-4 w-40" /> : null}
      {bars ? <Bone className="w-full" style={{ height: bars * 40 + 8 }} /> : <Bone className="h-[200px] w-full sm:h-[240px]" />}
      {minis ? (
        <div className="grid grid-cols-3 gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col gap-2">
              <Bone className="h-4 w-20" />
              <Bone className="h-16 w-full" />
            </div>
          ))}
        </div>
      ) : null}
      <Bone className="h-11 w-36" />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Calls over time + the small multiples
// ---------------------------------------------------------------------------------------------------------------------

export function CallsCard({ part, loading, busy, onRetry, bucket }: BlockProps<ActivityPart> & { bucket: Bucket }) {
  const tc = useTranslations("Analytics.calls");
  const locale = useLocale();
  const narrow = useNarrow();
  const entrance = useEntrance();
  const name = useBucketName(bucket);
  const view = blockView(part, loading);
  const rows = useMemo(() => (view.kind === "ok" ? callsRows(view.data) : []), [view]);

  let body: React.ReactNode;
  if (view.kind === "loading") body = <ChartSkeleton legend minis />;
  else if (view.kind === "error") body = <BlockError block={tc("block")} onRetry={onRetry} />;
  else if (activityEmpty(view.data)) body = <EmptyLine text={tc("empty")} href="/leads/queue" action={tc("emptyAction")} />;
  else {
    const totals = view.data.totals;
    const top = busiest(rows, (r) => r.calls);
    const caption =
      totals.calls > 0
        ? tc("caption", {
            calls: totals.calls,
            rate: percentOrDash(ratio(totals.reached, totals.calls), locale),
            day: top ? name(top.start, top.partial) : NO_FIGURE,
            count: top?.calls ?? 0,
          })
        : tc("captionNoCalls", { emails: totals.emails, whatsapp: totals.whatsapp, meetings: totals.meetings });
    const tooltip = (r: CallsRow & { total: number }): TooltipBody => ({
      lead: name(r.start, r.partial),
      lines: [r.calls > 0 ? tc("tooltip", { calls: r.calls, reached: r.reached, rate: percentOrDash(ratio(r.reached, r.calls), locale) }) : tc("tooltipNoCalls")],
    });
    const chartRows = rows.map((r) => ({ ...r, total: r.calls, part: r.reached }));
    const table: Row[] = rows.map((r) => ({
      key: r.key,
      cells: [
        name(r.start, r.partial),
        formatCount(r.calls, locale),
        formatCount(r.reached, locale),
        percentOrDash(ratio(r.reached, r.calls), locale),
        formatCount(r.emails, locale),
        formatCount(r.whatsapp, locale),
        formatCount(r.meetings, locale),
      ],
    }));
    const minis = [
      { key: "emails", label: tc("emails"), total: totals.emails, pick: (r: CallsRow) => r.emails, extra: null },
      { key: "whatsapp", label: tc("whatsapp"), total: totals.whatsapp, pick: (r: CallsRow) => r.whatsapp, extra: null },
      { key: "meetings", label: tc("meetings"), total: totals.meetings, pick: (r: CallsRow) => r.meetings, extra: totals.meetings_held > 0 ? tc("meetingsHeld", { count: totals.meetings_held }) : null },
    ] as const;
    body = (
      <ChartFrame
        heading={tc("title")}
        caption={caption}
        table={
          <DataTable
            caption={tc("title")}
            columns={[
              { key: "bucket", label: bucket === "day" ? tc("table.day") : tc("table.week") },
              { key: "calls", label: tc("table.calls"), numeric: true },
              { key: "reached", label: tc("table.reached"), numeric: true },
              { key: "rate", label: tc("table.rate"), numeric: true },
              { key: "emails", label: tc("table.emails"), numeric: true },
              { key: "whatsapp", label: tc("table.whatsapp"), numeric: true },
              { key: "meetings", label: tc("table.meetings"), numeric: true },
            ]}
            rows={table}
          />
        }
      >
        {(captionId) => (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
              <span className="inline-flex items-center gap-2">
                <span aria-hidden="true" className="size-2.5 rounded-sm bg-[var(--chart-ink)]" />
                {tc("reached")}
              </span>
              <span className="inline-flex items-center gap-2">
                <span aria-hidden="true" className="size-2.5 rounded-sm bg-[var(--chart-ink-35)]" />
                {tc("notReached")}
              </span>
            </div>
            <ChartBox className="h-[200px] sm:h-[240px]">
              <ColumnChart
                rows={chartRows}
                label={bucket === "day" ? tc("chartDays") : tc("chartWeeks")}
                describedBy={captionId}
                split
                direct={top ? { key: top.key, text: formatCount(top.calls, locale) } : null}
                tickLabel={(k) => bucketDate(k, locale)}
                yTick={(n) => formatCompact(n, locale)}
                tooltip={tooltip}
                interval={tickInterval(bucket, narrow)}
                entrance={entrance}
                order={0}
              />
            </ChartBox>
            <div className="grid grid-cols-3 gap-3 sm:gap-4">
              {minis.map((m, i) => (
                <div key={m.key} className="flex min-w-0 flex-col gap-1">
                  <p className="flex flex-wrap items-baseline gap-x-2 text-[13px] text-muted-foreground">
                    <span>{m.label}</span>
                    <span className="font-mono text-foreground">{formatCount(m.total, locale)}</span>
                    {m.extra ? <span>{m.extra}</span> : null}
                  </p>
                  <ChartBox height={64}>
                    <ColumnChart
                      rows={rows.map((r) => ({ ...r, total: m.pick(r) }))}
                      label={null}
                      axes={false}
                      tickLabel={(k) => bucketDate(k, locale)}
                      tooltip={(r) => ({ lead: name(r.start, r.partial), lines: [`${m.label} · ${formatCount(m.pick(r), locale)}`] })}
                      entrance={entrance}
                      order={i + 1}
                    />
                  </ChartBox>
                </div>
              ))}
            </div>
          </>
        )}
      </ChartFrame>
    );
  }
  return (
    <AnalyticsCard heading={tc("title")} labelId="analytics-calls" busy={busy} className="col-span-12 xl:col-span-8">
      {body}
    </AnalyticsCard>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Speed-to-lead
// ---------------------------------------------------------------------------------------------------------------------

function useDuration() {
  const t = useTranslations("Analytics.duration");
  const locale = useLocale();
  return (minutes: number) => {
    const d = duration(minutes);
    return d.kind === "minutes"
      ? t("minutes", { m: d.m })
      : d.kind === "hours"
        ? t("hours", { h: d.h })
        : d.kind === "hoursMinutes"
        ? t("hoursMinutes", { h: d.h, m: d.m })
          : t("days", { d: formatDays(d.d, locale) });
  };
}

export function SpeedCard({ part, loading, busy, onRetry }: BlockProps<SpeedPart>) {
  const ts = useTranslations("Analytics.speed");
  const locale = useLocale();
  const narrow = useNarrow();
  const entrance = useEntrance();
  const fmtDuration = useDuration();
  const view = blockView(part, loading);

  let body: React.ReactNode;
  if (view.kind === "loading") body = <SpeedSkeleton />;
  else if (view.kind === "error") body = <BlockError block={ts("block")} onRetry={onRetry} />;
  else if (view.data.leads === 0) body = <EmptyLine text={ts("empty")} />;
  else {
    const s = view.data;
    const rows = speedRows(s);
    const median = s.median_minutes === null ? null : fmtDuration(s.median_minutes);
    const bars: BarRow[] = rows.map((r) => ({
      key: r.key,
      label: ts(`buckets.${r.key}`),
      value: r.count,
      tone: r.key === "none" ? "ink35" : "ink",
      tip: `${formatCount(r.count, locale)} · ${percentOrDash(r.share, locale)}`,
    }));
    body = (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <p className="font-mono text-2xl font-medium md:text-[28px] md:leading-9">{median ? ts("median", { duration: median }) : ts("medianNone")}</p>
          <p className="text-[13px] text-muted-foreground">
            {ts("sub", { within1h: percentOrDash(ratio(s.within_1h, s.leads), locale), within24h: percentOrDash(ratio(s.within_24h, s.leads), locale) })}
          </p>
        </div>
        <ChartFrame
          heading={ts("title")}
          caption={median ? ts("caption", { leads: s.leads, touched: s.touched, duration: median }) : ts("captionUntouched", { leads: s.leads })}
          table={
            <DataTable
              caption={ts("title")}
              columns={[
                { key: "bucket", label: ts("table.bucket") },
                { key: "leads", label: ts("table.leads"), numeric: true },
                { key: "share", label: ts("table.share"), numeric: true },
              ]}
              rows={rows.map((r) => ({ key: r.key, cells: [ts(`buckets.${r.key}`), formatCount(r.count, locale), percentOrDash(r.share, locale)] }))}
            />
          }
        >
          {(captionId) => (
            <ChartBox height={bars.length * 40 + 8}>
              <BarList
                rows={bars}
                label={ts("chart")}
                describedBy={captionId}
                labelChars={narrow ? 16 : 18}
                labelWidth={narrow ? 116 : 128}
                tooltip={(r) => ({ lead: r.label, lines: [ts("tooltip", { count: r.value, share: percentOrDash(ratio(r.value, s.leads), locale) })] })}
                entrance={entrance}
                order={4}
              />
            </ChartBox>
          )}
        </ChartFrame>
      </div>
    );
  }
  return (
    <AnalyticsCard heading={ts("title")} labelId="analytics-speed" busy={busy} className="col-span-12 xl:col-span-4">
      {body}
    </AnalyticsCard>
  );
}

export function SpeedSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      <div className="flex flex-col gap-1">
        <Bone className="h-8 w-48 md:h-9" />
        <Bone className="h-[18px] w-64 max-w-full" />
      </div>
      <ChartSkeleton bars={5} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Deal funnel + days in stage
// ---------------------------------------------------------------------------------------------------------------------

export function FunnelCard({ part, loading, busy, onRetry }: BlockProps<PipelinePart>) {
  const tf = useTranslations("Analytics.funnel");
  const tStage = useTranslations("Stages");
  const locale = useLocale();
  const narrow = useNarrow();
  const entrance = useEntrance();
  const view = blockView(part, loading);

  let body: React.ReactNode;
  if (view.kind === "loading") body = <FunnelSkeleton />;
  else if (view.kind === "error") body = <BlockError block={tf("block")} onRetry={onRetry} />;
  else if (pipelineEmpty(view.data)) body = <EmptyLine text={tf("empty")} href="/pipeline" action={tf("emptyAction")} />;
  else {
    const p = view.data;
    const f = p.funnel;
    const rows = funnelRows(p);
    const label = (key: string) => (key === "won" ? tf("won") : tStage(key));
    const bars: BarRow[] = rows.map((r) => ({
      key: r.key,
      label: label(r.key),
      value: r.count,
      tip: `${formatCount(r.count, locale)} · ${percentOrDash(r.share, locale)}`,
    }));
    const days = stageDays(p);
    body = (
      <div className="flex flex-col gap-4">
        {f.cohort === 0 ? (
          <p className="text-sm text-muted-foreground">{tf("noCohort")}</p>
        ) : (
          <ChartFrame
            heading={tf("title")}
            caption={tf("caption", { cohort: f.cohort, qualified: f.qualified, negotiations: f.negotiations, won: f.won })}
            footer={
              <div className="flex flex-col gap-1 text-[13px] text-muted-foreground">
                <p>{tf("footer", { open: f.still_open, lost: f.lost })}</p>
                <p>{tf("maturing")}</p>
              </div>
            }
            table={
              <DataTable
                caption={tf("title")}
                columns={[
                  { key: "stage", label: tf("table.stage") },
                  { key: "reached", label: tf("table.reached"), numeric: true },
                  { key: "share", label: tf("table.share"), numeric: true },
                ]}
                rows={rows.map((r) => ({ key: r.key, cells: [label(r.key), formatCount(r.count, locale), percentOrDash(r.share, locale)] }))}
              />
            }
          >
            {(captionId) => (
              <ChartBox height={bars.length * 40 + 8}>
                <BarList
                  rows={bars}
                  label={tf("chart")}
                  describedBy={captionId}
                  max={f.cohort}
                  labelChars={narrow ? 12 : 16}
                  labelWidth={narrow ? 96 : 120}
                  tooltip={(r) => ({ lead: r.label, lines: [tf("tooltip", { count: r.value, cohort: f.cohort, share: percentOrDash(ratio(r.value, f.cohort), locale) })] })}
                  entrance={entrance}
                  order={5}
                />
              </ChartBox>
            )}
          </ChartFrame>
        )}
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <h4 className="text-sm font-bold">{tf("daysTitle")}</h4>
          <dl className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-3">
            {days.map((d) => (
              <div key={d.key} className="flex flex-col gap-0.5">
                <dt className="text-[13px] text-muted-foreground">{tStage(d.key)}</dt>
                <dd className="font-mono text-sm">
                  {d.median === null ? tf("daysNone") : tf("days", { days: formatDays(d.median, locale) })}
                  {d.n > 0 ? <span className="block font-sans text-[13px] text-muted-foreground">{tf("daysCount", { count: d.n })}</span> : null}
                </dd>
              </div>
            ))}
          </dl>
        </div>
        {f.mistake > 0 || p.lost.mistake > 0 ? (
          <p className="text-[13px] text-muted-foreground">{tf("mistake", { count: Math.max(f.mistake, p.lost.mistake) })}</p>
        ) : null}
      </div>
    );
  }
  return (
    <AnalyticsCard heading={tf("title")} labelId="analytics-funnel" busy={busy} className="col-span-12 lg:col-span-7">
      {body}
    </AnalyticsCard>
  );
}

export function FunnelSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      <ChartSkeleton bars={4} />
      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <Bone className="h-5 w-32" />
        <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Bone key={i} className="h-10 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Lost reasons
// ---------------------------------------------------------------------------------------------------------------------

export function LostCard({ part, loading, busy, onRetry }: BlockProps<PipelinePart>) {
  const tl = useTranslations("Analytics.lost");
  const tf = useTranslations("Analytics.funnel");
  const tReason = useTranslations("LostReasons");
  const locale = useLocale();
  const narrow = useNarrow();
  const entrance = useEntrance();
  const view = blockView(part, loading);

  let body: React.ReactNode;
  if (view.kind === "loading") body = <ChartSkeleton bars={4} />;
  else if (view.kind === "error") body = <BlockError block={tl("block")} onRetry={onRetry} />;
  else {
    const p = view.data;
    const rows = lostRows(p);
    const total = rows.reduce((s, r) => s + r.count, 0);
    const mistake = p.lost.mistake > 0 ? <p className="text-[13px] text-muted-foreground">{tf("mistake", { count: p.lost.mistake })}</p> : null;
    if (rows.length === 0) {
      body = (
        <div className="flex flex-col gap-2">
          <EmptyLine text={tl("none")} />
          {mistake}
        </div>
      );
    } else {
      const bars: BarRow[] = rows.map((r) => ({
        key: r.key,
        label: tReason(r.key),
        value: r.count,
        tip: `${formatCount(r.count, locale)} · ${percentOrDash(r.share, locale)}`,
      }));
      body = (
        <ChartFrame
          heading={tl("title")}
          caption={tl("caption", { count: total, reason: tReason(rows[0].key), top: rows[0].count })}
          footer={mistake}
          table={
            <DataTable
              caption={tl("title")}
              columns={[
                { key: "reason", label: tl("table.reason") },
                { key: "deals", label: tl("table.deals"), numeric: true },
                { key: "share", label: tl("table.share"), numeric: true },
              ]}
              rows={rows.map((r) => ({ key: r.key, cells: [tReason(r.key), formatCount(r.count, locale), percentOrDash(r.share, locale)] }))}
            />
          }
        >
          {(captionId) => (
            <ChartBox height={bars.length * 40 + 8}>
              <BarList
                rows={bars}
                label={tl("chart")}
                describedBy={captionId}
                labelChars={narrow ? 17 : 18}
                labelWidth={narrow ? 124 : 136}
                tooltip={(r) => ({ lead: r.label, lines: [tl("tooltip", { count: r.value, share: percentOrDash(ratio(r.value, total), locale) })] })}
                entrance={entrance}
                order={6}
              />
            </ChartBox>
          )}
        </ChartFrame>
      );
    }
  }
  return (
    <AnalyticsCard heading={tl("title")} labelId="analytics-lost" busy={busy} className="col-span-12 lg:col-span-5">
      {body}
    </AnalyticsCard>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Revenue and top products
// ---------------------------------------------------------------------------------------------------------------------

export function RevenueCard({ part, loading, busy, onRetry, bucket }: BlockProps<SalesPart> & { bucket: Bucket }) {
  const tr = useTranslations("Analytics.revenue");
  const locale = useLocale();
  const narrow = useNarrow();
  const entrance = useEntrance();
  const name = useBucketName(bucket);
  const view = blockView(part, loading);

  let body: React.ReactNode;
  if (view.kind === "loading") body = <ChartSkeleton />;
  else if (view.kind === "error") body = <BlockError block={tr("block")} onRetry={onRetry} />;
  else if (view.data.totals.sales === 0) body = <EmptyLine text={tr("empty")} />;
  else {
    const s = view.data;
    const rows = revenueRows(s);
    const money = (n: number) => formatMoney(String(Math.round(n)), locale);
    const top = busiest(rows, (r) => r.revenue);
    const revenue = Number(s.totals.revenue);
    body = (
      <ChartFrame
        heading={tr("title")}
        caption={tr("caption", { revenue: money(revenue), sales: s.totals.sales, bucket: top ? name(top.start, top.partial) : NO_FIGURE, best: top ? money(top.revenue) : NO_FIGURE })}
        footer={
          <div className="flex flex-col gap-1 text-[13px] text-muted-foreground">
            <p>
              {tr("split", {
                stock: money(Number(s.totals.from_stock)),
                direct: money(Number(s.totals.direct)),
                average: money(revenue / Math.max(1, s.totals.sales)),
              })}
            </p>
            <p>{tr("exVat")}</p>
          </div>
        }
        table={
          <DataTable
            caption={tr("title")}
            columns={[
              { key: "bucket", label: bucket === "day" ? tr("table.day") : tr("table.week") },
              { key: "revenue", label: tr("table.revenue"), numeric: true },
              { key: "sales", label: tr("table.sales"), numeric: true },
            ]}
            rows={rows.map((r) => ({ key: r.key, cells: [name(r.start, r.partial), money(r.revenue), formatCount(r.sales, locale)] }))}
          />
        }
      >
        {(captionId) => (
          <ChartBox className="h-[200px] sm:h-[240px]">
            <ColumnChart
              rows={rows.map((r) => ({ ...r, total: r.revenue }))}
              label={bucket === "day" ? tr("chartDays") : tr("chartWeeks")}
              describedBy={captionId}
              tickLabel={(k) => bucketDate(k, locale)}
              yTick={(n) => formatMoneyCompact(n, locale)}
              yWidth={64}
              tooltip={(r) => ({ lead: name(r.start, r.partial), lines: [tr("tooltip", { revenue: money(r.revenue), sales: r.sales })] })}
              interval={tickInterval(bucket, narrow)}
              entrance={entrance}
              order={7}
            />
          </ChartBox>
        )}
      </ChartFrame>
    );
  }
  return (
    <AnalyticsCard heading={tr("title")} labelId="analytics-revenue" busy={busy} className="col-span-12 lg:col-span-7">
      {body}
    </AnalyticsCard>
  );
}

export function ProductsCard({ part, loading, busy, onRetry }: BlockProps<SalesPart>) {
  const tp = useTranslations("Analytics.products");
  const locale = useLocale();
  const narrow = useNarrow();
  const entrance = useEntrance();
  const view = blockView(part, loading);

  let body: React.ReactNode;
  if (view.kind === "loading") body = <ChartSkeleton bars={6} />;
  else if (view.kind === "error") body = <BlockError block={tp("block")} onRetry={onRetry} />;
  else if (view.data.top_products.length === 0) body = <EmptyLine text={tp("empty")} />;
  else {
    const rows = productRows(view.data);
    const money = (n: number) => formatMoney(String(Math.round(n)), locale);
    const bars: BarRow[] = rows.map((r) => ({ key: r.key, label: r.name, value: r.revenue, tip: money(r.revenue) }));
    const byKey = new Map(rows.map((r) => [r.key, r]));
    body = (
      <ChartFrame
        heading={tp("title")}
        caption={tp("caption", { count: rows.length, name: rows[0].name, revenue: money(rows[0].revenue) })}
        table={
          <DataTable
            caption={tp("title")}
            columns={[
              { key: "product", label: tp("table.product") },
              { key: "revenue", label: tp("table.revenue"), numeric: true },
              { key: "pieces", label: tp("table.pieces"), numeric: true },
            ]}
            rows={rows.map((r) => ({ key: r.key, cells: [r.name, money(r.revenue), formatCount(r.pieces, locale)] }))}
          />
        }
      >
        {(captionId) => (
          <ChartBox height={bars.length * 40 + 8}>
            <BarList
              rows={bars}
              label={tp("chart")}
              describedBy={captionId}
              labelChars={narrow ? 12 : 18}
              labelWidth={narrow ? 104 : 144}
              tooltip={(r) => {
                const p = byKey.get(r.key)!;
                return { lead: p.name, lines: [tp("tooltip", { revenue: money(p.revenue), pieces: p.pieces })] };
              }}
              entrance={entrance}
              order={8}
            />
          </ChartBox>
        )}
      </ChartFrame>
    );
  }
  return (
    <AnalyticsCard heading={tp("title")} labelId="analytics-products" busy={busy} className="col-span-12 lg:col-span-5">
      {body}
    </AnalyticsCard>
  );
}
