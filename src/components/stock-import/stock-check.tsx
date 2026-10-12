"use client";

import { useCallback, useEffect, useEffectEvent, useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Notice, Tile } from "@/components/stock-import/bits";
import { buildProblemsCsv, problemsFileName, type ParsedCsv } from "@/lib/import";
import {
  STOCK_DB_WARNINGS,
  STOCK_FIX_CODES,
  type StockChange,
  type StockCheckSummary,
  type StockIssue,
  type StockNormalised,
} from "@/lib/stock-import";
import { useModKey } from "@/lib/use-platform";
import { cn } from "@/lib/utils";

export type FetchPage = <T>(url: string) => Promise<T | null>;

const ISSUE_PAGE = 300;

// Step 3: what the import would do (design 7.9). Tiles, pieces before and after, warnings with counts, the products
// left alone, the "use the sheet's quantities" switch, the rows that need a look (with the problems file), and the
// change table, paged from the database. Nothing has changed in the CRM yet.
export function StockCheck({
  batchId,
  fileName,
  parsed,
  rows,
  summary,
  issues,
  issuesFailed,
  busy,
  fetchPage,
  headingRef,
  onImport,
  onPolicy,
  onDiscard,
  onReload,
}: {
  batchId: string;
  fileName: string;
  /** The file as read in this browser (for names and the problems file); null when reopened from Past imports. */
  parsed: ParsedCsv | null;
  rows: StockNormalised[] | null;
  summary: StockCheckSummary;
  issues: StockIssue[] | null;
  issuesFailed: boolean;
  busy: boolean;
  fetchPage: FetchPage;
  headingRef: React.Ref<HTMLHeadingElement>;
  onImport: () => void;
  onPolicy: (useSheet: boolean) => void;
  onDiscard: () => void;
  onReload: () => void;
}) {
  const t = useTranslations("StockImport.check");
  const tc = useTranslations("StockImport");
  const format = useFormatter();
  const modKey = useModKey();
  const n = useCallback((v: number) => format.number(v), [format]);
  const c = summary.issue_counts;
  const count = (key: string) => Number(c[key] ?? 0);
  const created = count("products_new");
  const updated = count("products_update");
  const moved = count("products_moved");
  const unchanged = count("products_unchanged");
  const belowReserved = count("products_below_reserved");
  const nothingToDo = created + updated + moved === 0;
  const names = useMemo(() => {
    const m = new Map<number, string>();
    for (const r of rows ?? []) m.set(r.row_no, r.display.name);
    return m;
  }, [rows]);

  const messagesFor = useCallback(
    (issue: StockIssue): string[] => {
      const out: string[] = [];
      for (const p of issue.problems) out.push(tc(`problems.${p}`));
      if (issue.outcome === "repeated" && issue.match_row_no) out.push(t("repeatedOf", { row: issue.match_row_no }));
      if (issue.reason) out.push(tc(`reasons.${issue.reason}`));
      if (issue.outcome === "moved" && !issue.reason) out.push(tc("reasons.moved_in_crm"));
      for (const f of issue.fixes) out.push(tc(`fixes.${f}`));
      for (const w of issue.db_warnings) out.push(tc(`dbWarnings.${w}`));
      return out;
    },
    [t, tc],
  );

  const [shownIssues, setShownIssues] = useState(ISSUE_PAGE);
  const notImported = useMemo(() => (issues ?? []).filter((i) => i.outcome === "rejected" || i.outcome === "repeated"), [issues]);

  const download = () => {
    if (!parsed || !issues) return;
    const csv = buildProblemsCsv({
      delimiter: parsed.delimiter,
      headers: parsed.rawHeaders,
      records: parsed.records,
      issues: notImported.map((i) => ({ row_no: i.row_no, messages: messagesFor(i) })),
      labels: { row: t("csvRow"), problem: t("csvProblem") },
    });
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = problemsFileName(fileName, new Date().toISOString()).replace(/^leads-/, "stock-");
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const onShortcut = useEffectEvent(() => {
    if (!busy && !nothingToDo) onImport();
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !document.querySelector("[role=dialog]")) {
        event.preventDefault();
        onShortcut();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const warnings = [...STOCK_FIX_CODES, ...STOCK_DB_WARNINGS].filter((code) => count(code) > 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h2 ref={headingRef} id="stock-step-heading" tabIndex={-1} className="text-xl font-bold tracking-[-0.03em] text-balance focus:outline-none">
          {t("title")}
        </h2>
        <p className="max-w-[65ch] text-muted-foreground wrap-anywhere">
          {t("fileLine", { file: fileName, rows: summary.row_count, rowsFormatted: n(summary.row_count) })}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label={t("tiles.new")} value={n(created)} />
        <Tile label={t("tiles.updated")} value={n(updated)} />
        <Tile label={t("tiles.kept")} value={n(moved)} tone={moved > 0 ? "amber" : undefined} />
        <Tile label={t("tiles.rejected")} value={n(summary.rejected)} tone={summary.rejected > 0 ? "red" : undefined} />
      </div>
      <p className="text-sm text-muted-foreground">
        {t("lineBelow", { repeated: summary.repeated, repeatedFormatted: n(summary.repeated), unchanged, unchangedFormatted: n(unchanged) })}
      </p>

      <section className="flex flex-col gap-2" aria-labelledby="stock-pieces-heading">
        <h3 id="stock-pieces-heading" className="font-bold">
          {t("piecesTitle")}
        </h3>
        <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <PiecesLine label={tc("places.warehouse")} before={summary.wh_before} after={summary.wh_after} />
          <PiecesLine label={tc("places.transit")} before={summary.tr_before} after={summary.tr_after} />
        </dl>
      </section>

      <div className="flex flex-col gap-2">
        {belowReserved > 0 ? <Notice tone="amber">{t("belowReserved", { count: belowReserved, formatted: n(belowReserved) })}</Notice> : null}
        {summary.not_in_sheet > 0 ? (
          <Notice tone="amber">{t("notInSheet", { count: summary.not_in_sheet, formatted: n(summary.not_in_sheet) })}</Notice>
        ) : null}
        {moved > 0 || summary.use_sheet ? (
          <div className="flex flex-col gap-2 rounded-md bg-muted px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm">
              {summary.use_sheet ? t("usingSheet") : t("keptExplained", { count: moved, formatted: n(moved) })}
            </p>
            <Button variant="quiet" className="bg-background" disabled={busy} onClick={() => onPolicy(!summary.use_sheet)}>
              {summary.use_sheet ? t("keepCrm") : t("useSheet", { count: moved, formatted: n(moved) })}
            </Button>
          </div>
        ) : null}
      </div>

      {warnings.length > 0 ? (
        <section className="flex flex-col gap-2" aria-labelledby="stock-warnings-heading">
          <h3 id="stock-warnings-heading" className="font-bold">
            {t("warningsTitle")}
          </h3>
          <ul className="flex flex-col gap-1">
            {warnings.map((code) => (
              <li key={code} className="flex items-start gap-2 text-sm">
                <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-status-amber" />
                <span>{tc(`warningCounts.${code}`, { count: count(code), formatted: n(count(code)) })}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="flex flex-col gap-3" aria-labelledby="stock-issues-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="stock-issues-heading" className="font-bold">
            {t("issuesTitle")}
          </h3>
          {parsed && notImported.length > 0 ? (
            <Button variant="quiet" onClick={download}>
              {t("download", { count: notImported.length, formatted: n(notImported.length) })}
            </Button>
          ) : null}
        </div>
        {issuesFailed ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 rounded-md bg-muted px-4 py-3">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-status-red" />
            <p className="text-sm">{t("issuesFailed")}</p>
            <Button variant="quiet" className="bg-background" onClick={onReload}>
              {t("retry")}
            </Button>
          </div>
        ) : issues === null ? (
          <ul aria-label={t("loading")} className="flex flex-col divide-y divide-border rounded-md border border-border">
            {[0, 1, 2].map((i) => (
              <li key={i} className="flex flex-col gap-2 p-4">
                <span className="h-4 w-40 rounded-sm bg-muted motion-safe:animate-pulse" />
                <span className="h-3 w-64 max-w-full rounded-sm bg-muted motion-safe:animate-pulse" />
              </li>
            ))}
          </ul>
        ) : issues.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noIssues")}</p>
        ) : (
          <>
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
              {issues.slice(0, shownIssues).map((issue) => {
                const bad = issue.outcome === "rejected" || issue.outcome === "repeated";
                return (
                  <li key={issue.row_no} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 p-4">
                    <span className="font-mono text-xs text-muted-foreground tabular-nums">{t("row", { row: issue.row_no })}</span>
                    <span className="flex min-w-0 items-center gap-2">
                      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", bad ? "bg-status-red" : "bg-status-amber")} />
                      <span className="truncate font-bold" translate="no">
                        {names.get(issue.row_no) || t("noName")}
                      </span>
                      <span className="sr-only">{bad ? t("notImported") : t("imported")}</span>
                    </span>
                    <span className="col-start-2 text-sm text-muted-foreground">{messagesFor(issue).join(" · ")}</span>
                  </li>
                );
              })}
            </ul>
            {issues.length > shownIssues ? (
              <Button variant="quiet" className="self-start" onClick={() => setShownIssues((v) => v + ISSUE_PAGE)}>
                {t("showMore", { count: issues.length - shownIssues, formatted: n(issues.length - shownIssues) })}
              </Button>
            ) : null}
          </>
        )}
      </section>

      <ChangeTable batchId={batchId} fetchPage={fetchPage} version={summary.use_sheet ? "use_sheet" : "keep_crm"} />

      <div className="sticky bottom-24 z-10 flex flex-col gap-3 rounded-lg border border-border bg-background/95 p-4 backdrop-blur sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground" role="status">
          {nothingToDo ? t("nothingToDo") : t("safe")}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="quiet" onClick={onDiscard} disabled={busy}>
            {t("discard")}
          </Button>
          <Button onClick={onImport} disabled={busy || nothingToDo}>
            {t("import", { created, createdFormatted: n(created), updated: updated + moved, updatedFormatted: n(updated + moved) })}
            {modKey ? <Kbd className="max-sm:hidden">{`${modKey} ↩`}</Kbd> : null}
          </Button>
        </div>
      </div>
    </div>
  );
}

function PiecesLine({ label, before, after }: { label: string; before: number; after: number }) {
  const t = useTranslations("StockImport.check");
  const format = useFormatter();
  return (
    <div className="flex items-baseline justify-between gap-3 rounded-md bg-card px-4 py-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="font-mono tabular-nums">
        {t("beforeAfter", { before: format.number(before), after: format.number(after) })}
      </dd>
    </div>
  );
}

// The change table (design 7.9): one line per product, 200 at a time from the database (TanStack Query, keyed by the
// check's policy so a re-check reloads it).
function ChangeTable({ batchId, fetchPage, version }: { batchId: string; fetchPage: FetchPage; version: string }) {
  const t = useTranslations("StockImport.check");
  const tc = useTranslations("StockImport");
  const format = useFormatter();
  const query = useInfiniteQuery({
    queryKey: ["stock-import-changes", batchId, version],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const page = await fetchPage<{ changes: StockChange[] }>(`/api/stock-imports/${batchId}/changes?after=${pageParam}`);
      if (!page) throw new Error("changes");
      return page.changes;
    },
    getNextPageParam: (last) => (last.length === 200 ? last[last.length - 1].row_no : undefined),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const lines = query.data ? query.data.pages.flat() : null;
  const failed = query.isError;
  const more = query.hasNextPage;
  const loading = query.isFetchingNextPage;
  const load = () => void query.refetch();

  const price = (min: number | null, max: number | null) =>
    min === null && max === null
      ? "–"
      : min === max || max === null
        ? format.number(Number(min), { style: "currency", currency: "EUR" })
        : `${format.number(Number(min ?? 0), { style: "currency", currency: "EUR" })} – ${format.number(Number(max), { style: "currency", currency: "EUR" })}`;
  const qty = (before: number | null, after: number | null) =>
    before === after ? format.number(before ?? 0) : t("beforeAfter", { before: format.number(before ?? 0), after: format.number(after ?? 0) });

  return (
    <section className="flex flex-col gap-3" aria-labelledby="stock-changes-heading">
      <h3 id="stock-changes-heading" className="font-bold">
        {t("changesTitle")}
      </h3>
      {failed ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-md bg-muted px-4 py-3">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-status-red" />
          <p className="text-sm">{t("changesFailed")}</p>
          <Button variant="quiet" className="bg-background" onClick={load}>
            {t("retry")}
          </Button>
        </div>
      ) : lines === null ? (
        <div aria-label={t("loading")} className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <span key={i} className="h-12 rounded-md bg-muted motion-safe:animate-pulse" />
          ))}
        </div>
      ) : lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noChanges")}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-muted/50 text-left font-mono text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-2 font-normal">{t("colProduct")}</th>
                <th scope="col" className="px-4 py-2 text-right font-normal">{tc("places.warehouse")}</th>
                <th scope="col" className="px-4 py-2 text-right font-normal">{tc("places.transit")}</th>
                <th scope="col" className="px-4 py-2 text-right font-normal">{t("colPrice")}</th>
                <th scope="col" className="px-4 py-2 font-normal">{t("colWhat")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {lines.map((line) => (
                <tr key={`${line.row_no}-${line.product_id ?? "new"}`}>
                  <th scope="row" className="max-w-[16rem] truncate px-4 py-2 text-left font-bold" translate="no">
                    {line.product_name}
                  </th>
                  <td className="px-4 py-2 text-right font-mono tabular-nums whitespace-nowrap">{qty(line.wh_before, line.wh_after)}</td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums whitespace-nowrap">{qty(line.tr_before, line.tr_after)}</td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums whitespace-nowrap">
                    {line.created || (line.price_min_before === line.price_min_after && line.price_max_before === line.price_max_after)
                      ? price(line.price_min_after, line.price_max_after)
                      : t("beforeAfter", {
                          before: price(line.price_min_before, line.price_max_before),
                          after: price(line.price_min_after, line.price_max_after),
                        })}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    {line.created ? t("what.new") : tc(`outcomes.${line.outcome}`)}
                    {line.reason ? <span className="text-muted-foreground"> · {tc(`reasons.${line.reason}`)}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {more ? (
        <Button variant="quiet" className="self-start" disabled={loading} onClick={() => void query.fetchNextPage()}>
          {t("moreChanges")}
        </Button>
      ) : null}
    </section>
  );
}
