"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Download } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import type { LoadedFile } from "@/components/import/choose-step";
import type { OpenBatch, Phase } from "@/components/import/import-workspace";
import { issueKind, issueMessages, type IssueKind } from "@/components/import/issues";
import { ProgressBar } from "@/components/import/progress";
import { FIX_CODES, PROBLEM_CODES, REASON_CODES, buildProblemsCsv, type NormalisedRecord } from "@/lib/import";
import type { ImportIssue } from "@/lib/import-server";
import { useModKey } from "@/lib/use-platform";
import { cn } from "@/lib/utils";

type Filter = "all" | IssueKind;

// Steps 3 and 4: sending and checking the rows, the results (what will be added, what is skipped and why, the rows
// not imported as a CSV), then the import itself and its result.
export function CheckStep({
  headingRef,
  phase,
  batch,
  file,
  records,
  onImport,
  onDiscard,
  onRetryIssues,
  onStartOver,
}: {
  headingRef: React.Ref<HTMLHeadingElement>;
  phase: Exclude<Phase, { kind: "choose" } | { kind: "match" }>;
  batch: OpenBatch | null;
  file: LoadedFile | null;
  records: NormalisedRecord[];
  onImport: () => void;
  onDiscard: () => void;
  onRetryIssues: () => void;
  onStartOver: () => void;
}) {
  const t = useTranslations("Import.check");
  const format = useFormatter();
  const n = (value: number) => format.number(value);
  const heading = (text: string) => (
    <h2 ref={headingRef} id="import-step-heading" tabIndex={-1} className="text-xl font-bold tracking-[-0.03em] text-balance focus:outline-none">
      {text}
    </h2>
  );

  if (phase.kind === "sending" || phase.kind === "checking") {
    return (
      <div className="flex flex-col gap-5">
        {heading(t("checkingTitle"))}
        <div className="flex flex-col gap-2" aria-live="polite">
          <ProgressBar
            value={phase.kind === "sending" ? phase.done : 1}
            max={phase.kind === "sending" ? phase.total : 1}
            label={t("checkingTitle")}
          />
          <p className="text-sm text-muted-foreground">
            {phase.kind === "sending" ? t("sending", { done: n(phase.done), total: n(phase.total) }) : t("duplicates")}
          </p>
        </div>
        <TilesSkeleton />
      </div>
    );
  }

  if (phase.kind === "importing") {
    return (
      <div className="flex flex-col gap-5">
        {heading(t("importingTitle"))}
        <div className="flex flex-col gap-2" aria-live="polite">
          <ProgressBar value={phase.done} max={phase.total ?? Math.max(phase.done, 1)} label={t("importingTitle")} />
          <p className="text-sm text-muted-foreground">
            {phase.total ? t("importing", { done: n(phase.done), total: n(phase.total) }) : t("importingCount", { done: n(phase.done) })}
          </p>
          <p className="text-sm text-muted-foreground">{t("keepOpen")}</p>
        </div>
      </div>
    );
  }

  if (phase.kind === "done") {
    return (
      <div className="flex flex-col gap-5">
        {heading(t("doneTitle", { count: phase.added, formatted: n(phase.added) }))}
        <p className="max-w-[65ch] text-muted-foreground">
          {phase.late > 0 ? t("doneLate", { count: phase.late, formatted: n(phase.late) }) : t("doneBody")}
        </p>
        <div className="flex flex-col gap-3 sm:flex-row">
          {batch ? (
            <Link href={`/leads?batch=${batch.id}&sort=created`} className={buttonVariants({ variant: "neutral" })}>
              {t("seeLeads")}
            </Link>
          ) : null}
          <Button variant="quiet" onClick={onStartOver}>
            {t("another")}
          </Button>
        </div>
      </div>
    );
  }

  if (!batch) return null;
  return (
    <Results
      heading={heading}
      batch={batch}
      file={file}
      records={records}
      onImport={onImport}
      onDiscard={onDiscard}
      onRetryIssues={onRetryIssues}
    />
  );
}

function Results({
  heading,
  batch,
  file,
  records,
  onImport,
  onDiscard,
  onRetryIssues,
}: {
  heading: (text: string) => React.ReactNode;
  batch: OpenBatch;
  file: LoadedFile | null;
  records: NormalisedRecord[];
  onImport: () => void;
  onDiscard: () => void;
  onRetryIssues: () => void;
}) {
  const t = useTranslations("Import.check");
  const ti = useTranslations("Import");
  const format = useFormatter();
  const modKey = useModKey();
  const n = (value: number) => format.number(value);
  const counts = batch.summary.issue_counts;
  const ready = batch.summary.ready;
  const [filter, setFilter] = useState<Filter>("all");

  const names = useMemo(() => {
    const map = new Map<number, string>();
    for (const r of records) map.set(r.row_no, r.display.name);
    return map;
  }, [records]);
  const issues = useMemo(() => batch.issues ?? [], [batch.issues]);
  const shown = useMemo(() => (filter === "all" ? issues : issues.filter((i) => issueKind(i) === filter)), [issues, filter]);
  const reasons = [...PROBLEM_CODES, ...REASON_CODES]
    .map((code) => ({ code, count: counts[code] ?? 0 }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);
  const fixes = FIX_CODES.map((code) => ({ code, count: counts[code] ?? 0 })).filter((r) => r.count > 0);

  const download = () => {
    if (!file || !batch.issues) return;
    const csv = buildProblemsCsv({
      delimiter: file.parsed.delimiter,
      headers: file.parsed.rawHeaders,
      records: file.parsed.records,
      issues: batch.issues
        .filter((i) => i.outcome === "rejected" || i.outcome === "duplicate_file" || i.outcome === "duplicate_existing")
        .map((i) => ({ row_no: i.row_no, messages: issueMessages(ti, i) })),
      labels: { row: t("csvRow"), problem: t("csvProblem") },
    });
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${file.name.replace(/\.(csv|txt)$/i, "")}-${t("csvSuffix")}-${new Date().toLocaleDateString("sv-SE")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const onShortcut = useEffectEvent(() => {
    if (ready > 0) onImport();
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

  const notImported = (counts.rejected ?? batch.summary.rejected) + (counts.duplicate_file ?? 0) + (counts.duplicate_existing ?? 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        {heading(t("resultsTitle"))}
        <p className="text-muted-foreground">{t("resultsBody", { file: batch.filename, rows: n(batch.summary.row_count) })}</p>
      </div>

      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label={t("tiles.ready")} value={n(ready)} dot="bg-status-green" />
        <Tile label={t("tiles.existing")} value={n(counts.duplicate_existing ?? 0)} hint={t("tiles.existingHint")} />
        <Tile label={t("tiles.repeated")} value={n(counts.duplicate_file ?? 0)} hint={t("tiles.repeatedHint")} />
        <Tile label={t("tiles.rejected")} value={n(counts.rejected ?? batch.summary.rejected)} dot="bg-status-red" />
      </dl>

      {reasons.length > 0 || fixes.length > 0 ? (
        <div className="grid gap-6 sm:grid-cols-2">
          {reasons.length > 0 ? (
            <ReasonList title={t("whyNot")} items={reasons.map((r) => ({ key: r.code, count: n(r.count), text: reasonText(ti, r.code) }))} />
          ) : null}
          {fixes.length > 0 ? (
            <ReasonList title={t("withChanges")} items={fixes.map((f) => ({ key: f.code, count: n(f.count), text: ti(`fixes.${f.code}`) }))} />
          ) : null}
        </div>
      ) : null}

      {notImported > 0 || fixes.length > 0 ? (
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-bold">{t("rowsTitle")}</h3>
            {file && batch.issues ? (
              <Button variant="quiet" onClick={download} disabled={notImported === 0}>
                <Download aria-hidden="true" strokeWidth={1.75} className="size-4" />
                {t("download")}
              </Button>
            ) : null}
          </div>
          {file ? (
            notImported > 0 ? <p className="text-sm text-muted-foreground">{t("downloadNow")}</p> : null
          ) : (
            <p className="text-sm text-muted-foreground">{t("noFile")}</p>
          )}
          <div role="group" aria-label={t("filterLabel")} className="flex flex-wrap gap-2">
            {(["all", "rejected", "duplicate_file", "duplicate_existing", "fixed"] as const).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                className={cn(
                  "min-h-9 rounded-full px-3 text-sm transition-[background-color,transform] active:scale-[0.97]",
                  filter === f ? "bg-foreground text-background" : "bg-muted text-foreground hover:brightness-95 dark:hover:brightness-125",
                )}
              >
                {t(`filters.${f}`)}
              </button>
            ))}
          </div>
          {batch.issuesError ? (
            <div role="alert" className="flex flex-col items-start gap-3 rounded-md bg-muted p-4">
              <p>{t("issuesError")}</p>
              <Button variant="quiet" onClick={onRetryIssues}>
                {t("retry")}
              </Button>
            </div>
          ) : batch.issues === null ? (
            <RowsSkeleton />
          ) : shown.length === 0 ? (
            <p className="rounded-md bg-muted p-4 text-muted-foreground">{t("noRows")}</p>
          ) : (
            <IssueList issues={shown} names={file ? names : null} />
          )}
        </section>
      ) : null}

      <div className="sticky bottom-24 z-10 -mx-4 flex flex-col gap-3 border-t border-border bg-card px-4 pt-4 pb-2 sm:static sm:mx-0 sm:flex-row-reverse sm:items-center sm:justify-between sm:border-0 sm:p-0">
        {ready > 0 ? (
          <Button onClick={onImport}>
            {t("import", { count: ready, formatted: n(ready) })}
            {modKey ? <Kbd className="border-transparent bg-black/10 text-brand-foreground max-sm:hidden">{`${modKey} ↩`}</Kbd> : null}
          </Button>
        ) : (
          <p className="text-muted-foreground">{t("nothingNew")}</p>
        )}
        <Button variant="quiet" onClick={onDiscard}>
          {t("discard")}
        </Button>
      </div>
    </div>
  );
}

function reasonText(t: ReturnType<typeof useTranslations>, code: string) {
  return (PROBLEM_CODES as readonly string[]).includes(code) ? t(`problems.${code}`) : t(`reasons.${code}`);
}

function Tile({ label, value, hint, dot }: { label: string; value: string; hint?: string; dot?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-md bg-muted p-4">
      <dt className="flex items-center gap-2 text-sm">
        {dot ? <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", dot)} /> : null}
        {label}
      </dt>
      <dd className="font-mono text-2xl font-medium">{value}</dd>
      {hint ? <dd className="text-xs text-muted-foreground">{hint}</dd> : null}
    </div>
  );
}

function ReasonList({ title, items }: { title: string; items: { key: string; count: string; text: string }[] }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-bold">{title}</h3>
      <ul className="flex flex-col gap-1.5">
        {items.map((item) => (
          <li key={item.key} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 text-sm">
            <span className="text-right font-mono">{item.count}</span>
            <span>{item.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Up to 50,000 rows: only the visible ones exist in the page (TanStack Virtual).
function IssueList({ issues, names }: { issues: ImportIssue[]; names: Map<number, string> | null }) {
  const t = useTranslations("Import.check");
  const ti = useTranslations("Import");
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: issues.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 8,
  });
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="grid grid-cols-[4rem_minmax(0,1fr)] gap-3 border-b border-border bg-muted px-4 py-2 font-mono text-xs text-muted-foreground sm:grid-cols-[4rem_minmax(0,1fr)_minmax(0,1.4fr)]">
        <span>{t("colRow")}</span>
        <span className="max-sm:hidden">{t("colCompany")}</span>
        <span>{t("colWhat")}</span>
      </div>
      <div ref={scrollRef} className="max-h-[420px] overflow-y-auto overscroll-contain" role="list" aria-label={t("rowsTitle")}>
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const issue = issues[item.index];
            const name = names?.get(issue.row_no);
            return (
              <div
                key={issue.row_no}
                role="listitem"
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="absolute top-0 left-0 grid w-full grid-cols-[4rem_minmax(0,1fr)] gap-3 border-b border-border px-4 py-3 text-sm sm:grid-cols-[4rem_minmax(0,1fr)_minmax(0,1.4fr)]"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <span className="font-mono">{issue.row_no}</span>
                <span className="truncate max-sm:hidden" title={name ?? undefined}>
                  {names ? name || t("noName") : t("chooseFileForNames")}
                </span>
                <span className="flex items-start gap-2">
                  <KindDot kind={issueKind(issue)} />
                  <span>{issueMessages(ti, issue).join(" · ")}</span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function KindDot({ kind }: { kind: IssueKind }) {
  const tone = kind === "rejected" ? "bg-status-red" : kind === "fixed" ? "bg-status-amber" : "bg-muted-foreground";
  return <span aria-hidden="true" className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", tone)} />;
}

function TilesSkeleton() {
  return (
    <div aria-hidden="true" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-[92px] rounded-md bg-muted motion-safe:animate-pulse" />
      ))}
    </div>
  );
}

function RowsSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-2">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-12 rounded-md bg-muted motion-safe:animate-pulse" />
      ))}
    </div>
  );
}
