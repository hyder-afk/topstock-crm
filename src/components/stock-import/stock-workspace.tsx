"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import {
  checkStockImport,
  commitStockStep,
  discardStockImport,
  listStockImports,
  previewStockUndo,
  stageStockRows,
  startStockImport,
  undoStockStep,
} from "@/app/(app)/inventory/import/actions";
import { useStepUp } from "@/components/auth/step-up-dialog";
import { DiscardDialog } from "@/components/import/discard-dialog";
import { ProgressBar } from "@/components/import/progress";
import { ImportStopped, attempt, type Runner } from "@/components/import/run";
import { Stepper, type StepId } from "@/components/import/stepper";
import { refreshInventory } from "@/components/inventory/use-inventory";
import { buttonVariants, Button } from "@/components/ui/button";
import { StockCheck, type FetchPage } from "@/components/stock-import/stock-check";
import { StockChoose } from "@/components/stock-import/stock-choose";
import { StockHistory, StockUndoDialog, type UndoState } from "@/components/stock-import/stock-history";
import { StockMatch, type StockChoices } from "@/components/stock-import/stock-match";
import type { LoadedStockFile } from "@/components/stock-import/read-stock-file";
import { iterChunks } from "@/lib/import";
import {
  COMMIT_CHUNK,
  MIN_CHUNK,
  STOCK_LIMITS,
  type StockCheckSummary,
  type StockImportBatch,
  type StockIssue,
  type StockNormalised,
  type StockRow,
} from "@/lib/stock-import";

// The stock sheet import (Day 6c; design docs/evidence/day6/design.md section 7): choose the sheet (it stays in this
// browser), match its columns, check what would change (nothing written to the stock yet), import, and undo from the
// history. Every write needs an admin with an authenticator code from the last 10 minutes ("Confirm it's you").
type Phase =
  | { kind: "choose" }
  | { kind: "match" }
  | { kind: "sending"; done: number; total: number }
  | { kind: "checking" }
  | { kind: "review" }
  | { kind: "importing"; done: number; total: number | null }
  | { kind: "done"; created: number; updated: number; kept: number };

type OpenBatch = { id: string; filename: string; summary: StockCheckSummary };
type ErrorKey = string;

const stepOf: Record<Phase["kind"], StepId> = {
  choose: "choose",
  match: "match",
  sending: "check",
  checking: "check",
  review: "check",
  importing: "import",
  done: "import",
};

export function StockImportWorkspace({ initialImports, stepUpSeconds }: { initialImports: StockImportBatch[] | null; stepUpSeconds: number }) {
  const t = useTranslations("StockImport");
  const format = useFormatter();
  const queryClient = useQueryClient();
  const stepUp = useStepUp(stepUpSeconds, "bodyStock");
  const [phase, setPhase] = useState<Phase>({ kind: "choose" });
  const [file, setFile] = useState<LoadedStockFile | null>(null);
  const [rows, setRows] = useState<StockNormalised[] | null>(null);
  const [batch, setBatch] = useState<OpenBatch | null>(null);
  const [issues, setIssues] = useState<StockIssue[] | null>(null);
  const [issuesFailed, setIssuesFailed] = useState(false);
  const [imports, setImports] = useState<StockImportBatch[] | null>(initialImports);
  const [historyFailed, setHistoryFailed] = useState(initialImports === null);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [discarding, setDiscarding] = useState<string | null>(null);
  const [undo, setUndo] = useState<UndoState>({ kind: "closed" });
  const busy = phase.kind === "sending" || phase.kind === "checking" || phase.kind === "importing" || undo.kind === "running";
  const headingRef = useRef<HTMLHeadingElement>(null);
  const historyHeadingRef = useRef<HTMLHeadingElement>(null);
  const discardFrom = useRef<"results" | "history">("results");
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const runner: Runner = useMemo(() => ({ requireFresh: stepUp.requireFresh }), [stepUp.requireFresh]);
  const n = useCallback((v: number) => format.number(v), [format]);
  // The step heading takes the focus after React has drawn the new step: a request is a render-time counter, so the
  // focus runs in the effect of the same commit that mounts the new heading. A requestAnimationFrame scheduled next to a
  // setState from an async callback could run before that commit in Safari, focus the old heading and lose the focus
  // when it unmounted (CI, PR #18, WebKit stock-import screens).
  const [headingFocus, setHeadingFocus] = useState(0);
  const focusHeading = useCallback(() => setHeadingFocus((n) => n + 1), []);
  useEffect(() => {
    if (headingFocus) headingRef.current?.focus();
  }, [headingFocus]);

  const refreshImports = useCallback(async () => {
    const res = await listStockImports({}).catch(() => null);
    if (!mounted.current) return;
    if (res?.ok) {
      setImports(res.data);
      setHistoryFailed(false);
    } else setHistoryFailed(true);
  }, []);

  // GET a page from the import routes; a stale code opens "Confirm it's you" once and retries.
  const fetchPage: FetchPage = useCallback(
    async <T,>(url: string): Promise<T | null> => {
      for (let tries = 0; tries < 2; tries++) {
        try {
          const res = await fetch(url, { cache: "no-store" });
          if (res.ok) return (await res.json()) as T;
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          if (res.status === 403 && body?.error === "step_up" && tries === 0 && (await stepUp.requireFresh())) continue;
          return null;
        } catch {
          return null;
        }
      }
      return null;
    },
    [stepUp],
  );

  const loadIssues = useCallback(
    async (batchId: string) => {
      setIssues(null);
      setIssuesFailed(false);
      const all: StockIssue[] = [];
      let after = 0;
      for (;;) {
        const page = await fetchPage<{ issues: StockIssue[] }>(`/api/stock-imports/${batchId}/issues?after=${after}`);
        if (!mounted.current) return;
        if (!page) {
          setIssuesFailed(true);
          return;
        }
        all.push(...page.issues);
        if (page.issues.length < 1000) break;
        after = page.issues[page.issues.length - 1].row_no;
      }
      setIssues(all);
    },
    [fetchPage],
  );

  const startOver = useCallback(() => {
    setFile(null);
    setRows(null);
    setBatch(null);
    setIssues(null);
    setError(null);
    setPhase({ kind: "choose" });
    focusHeading();
  }, [focusHeading]);

  // Check: start a stock import, send the cleaned rows in chunks, run the check (keep the CRM's numbers by default).
  const runCheck = async (choices: StockChoices, cleaned: StockNormalised[]) => {
    if (!file) return;
    setError(null);
    if (!(await stepUp.ensureFresh(180))) return;
    setRows(cleaned);
    const payload: StockRow[] = cleaned.map((r) => r.payload);
    setPhase({ kind: "sending", done: 0, total: payload.length });
    focusHeading();
    let batchId: string | null = null;
    try {
      const started = await attempt(runner, () =>
        startStockImport({ filename: file.name.slice(0, 255) || "stock.csv", sha256: file.sha256, rowCount: file.parsed.rowCount, lastRowNo: file.parsed.lastRowNo }),
      );
      batchId = started.batchId;
      let sent = 0;
      for (const chunk of iterChunks(payload, { maxRows: STOCK_LIMITS.chunkRows, maxBytes: STOCK_LIMITS.chunkBytes })) {
        const id = batchId;
        await attempt(runner, () => stageStockRows({ batchId: id, rows: chunk }));
        sent += chunk.length;
        if (mounted.current) setPhase({ kind: "sending", done: sent, total: payload.length });
      }
      setPhase({ kind: "checking" });
      const id = batchId;
      const summary = await attempt(runner, () => checkStockImport({ batchId: id, policy: "keep_crm" }));
      if (!mounted.current) return;
      setBatch({ id, filename: file.name, summary });
      setPhase({ kind: "review" });
      focusHeading();
      void loadIssues(id);
      void refreshImports();
      void choices;
    } catch (cause) {
      // Thrown away even when the page was left meanwhile (it needs no screen): a half-sent import would stay staged.
      if (batchId) void discardStockImport({ batchId }).catch(() => null);
      if (!mounted.current) return;
      const code = cause instanceof ImportStopped ? cause.code : "unavailable";
      if (code !== "cancelled") setError(code);
      setPhase({ kind: "match" });
      focusHeading();
    }
  };

  const changePolicy = async (useSheet: boolean) => {
    if (!batch) return;
    setError(null);
    setPhase({ kind: "checking" });
    try {
      const id = batch.id;
      const summary = await attempt(runner, () => checkStockImport({ batchId: id, policy: useSheet ? "use_sheet" : "keep_crm" }));
      if (!mounted.current) return;
      setBatch({ ...batch, summary });
      void loadIssues(id);
    } catch (cause) {
      if (mounted.current && !(cause instanceof ImportStopped && cause.code === "cancelled")) setError(cause instanceof ImportStopped ? cause.code : "unavailable");
    }
    if (mounted.current) setPhase({ kind: "review" });
  };

  // Import: chunks of products until the status is "imported"; a timeout halves the chunk (replays are safe).
  const runImport = async (batchId: string, total: number | null, kept: number) => {
    setError(null);
    if (!(await stepUp.ensureFresh(60))) return;
    let size = COMMIT_CHUNK;
    let created = 0;
    setPhase({ kind: "importing", done: 0, total });
    focusHeading();
    for (;;) {
      try {
        const step = await attempt(runner, () => commitStockStep({ batchId, size }));
        created += step.created_now;
        const known = step.products_total + step.remaining;
        if (!mounted.current) return;
        if (step.status === "imported") {
          setPhase({ kind: "done", created, updated: Math.max(0, step.products_total - created), kept });
          setBatch(null);
          focusHeading();
          refreshInventory(queryClient);
          void refreshImports();
          return;
        }
        setPhase({ kind: "importing", done: step.products_total, total: total ?? known });
      } catch (cause) {
        if (cause instanceof ImportStopped && cause.code === "timeout" && size > MIN_CHUNK) {
          size = Math.max(MIN_CHUNK, Math.floor(size / 2));
          continue;
        }
        if (!mounted.current) return;
        setError(cause instanceof ImportStopped && cause.code !== "cancelled" ? cause.code : "paused");
        setPhase({ kind: "choose" });
        setBatch(null);
        void refreshImports();
        historyHeadingRef.current?.focus();
        return;
      }
    }
  };

  const discard = async (batchId: string) => {
    setError(null);
    if (!(await stepUp.ensureFresh(60))) return;
    try {
      await attempt(runner, () => discardStockImport({ batchId }));
      if (batch?.id === batchId) startOver();
    } catch (cause) {
      if (!(cause instanceof ImportStopped && cause.code === "cancelled")) setError("discard_failed");
    }
    void refreshImports();
  };

  const openUndo = async (item: StockImportBatch) => {
    setError(null);
    if (!(await stepUp.ensureFresh(120))) return;
    setUndo({ kind: "preview", item, preview: null, error: false });
    try {
      const preview = await attempt(runner, () => previewStockUndo({ batchId: item.id }));
      if (mounted.current) setUndo({ kind: "preview", item, preview, error: false });
    } catch {
      if (mounted.current) setUndo({ kind: "preview", item, preview: null, error: true });
    }
  };

  const runUndo = async () => {
    if (undo.kind !== "preview" || !undo.preview) return;
    const item = undo.item;
    const total = undo.preview.products;
    let done = 0;
    let size = COMMIT_CHUNK;
    setUndo({ kind: "running", item, done, total });
    for (;;) {
      try {
        const step = await attempt(runner, () => undoStockStep({ batchId: item.id, size }));
        done += step.done_now;
        if (!mounted.current) return;
        if (step.status === "rolled_back") {
          setUndo({ kind: "done", item, kept: step.kept ?? 0 });
          refreshInventory(queryClient);
          void refreshImports();
          return;
        }
        setUndo({ kind: "running", item, done, total });
      } catch (cause) {
        if (cause instanceof ImportStopped && cause.code === "timeout" && size > MIN_CHUNK) {
          size = Math.max(MIN_CHUNK, Math.floor(size / 2));
          continue;
        }
        if (!mounted.current) return;
        setUndo({ kind: "paused", item, code: cause instanceof ImportStopped && cause.code !== "cancelled" ? cause.code : "unavailable" });
        void refreshImports();
        return;
      }
    }
  };

  const summary = batch?.summary;
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start">
      <section aria-labelledby="stock-step-heading" className="flex min-w-0 flex-col gap-6 rounded-lg bg-card p-4 sm:p-8">
        <Stepper current={stepOf[phase.kind]} />
        {error ? (
          <div role="alert" className="flex items-start gap-2 rounded-md bg-muted px-4 py-3">
            <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-status-red" />
            <p>{t(`errors.${error}` as "errors.unavailable")}</p>
          </div>
        ) : null}
        {phase.kind === "choose" ? (
          <StockChoose
            headingRef={headingRef}
            announce={() => undefined}
            onLoaded={(loaded) => {
              setError(null);
              setFile(loaded);
              setPhase({ kind: "match" });
              focusHeading();
            }}
          />
        ) : null}
        {phase.kind === "match" && file ? (
          <StockMatch key={file.sha256} file={file} headingRef={headingRef} onBack={startOver} onContinue={(choices, cleaned) => void runCheck(choices, cleaned)} />
        ) : null}
        {phase.kind === "sending" || phase.kind === "checking" ? (
          <div className="flex flex-col gap-4">
            <h2 ref={headingRef} id="stock-step-heading" tabIndex={-1} className="text-xl font-bold tracking-[-0.03em] focus:outline-none">
              {t("check.checkingTitle")}
            </h2>
            <ProgressBar
              value={phase.kind === "sending" ? phase.done : null}
              max={phase.kind === "sending" ? phase.total : 1}
              label={phase.kind === "sending" ? t("check.sending", { done: n(phase.done), total: n(phase.total) }) : t("check.checking")}
            />
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {phase.kind === "sending" ? t("check.sending", { done: n(phase.done), total: n(phase.total) }) : t("check.checking")}
            </p>
          </div>
        ) : null}
        {phase.kind === "review" && batch && summary ? (
          <StockCheck
            batchId={batch.id}
            fileName={batch.filename}
            parsed={file?.parsed ?? null}
            rows={rows}
            summary={summary}
            issues={issues}
            issuesFailed={issuesFailed}
            busy={busy}
            fetchPage={fetchPage}
            headingRef={headingRef}
            onImport={() => {
              const c = summary.issue_counts;
              const total = Number(c.products_new ?? 0) + Number(c.products_update ?? 0) + Number(c.products_moved ?? 0);
              void runImport(batch.id, total, summary.use_sheet ? 0 : Number(c.products_moved ?? 0));
            }}
            onPolicy={(useSheet) => void changePolicy(useSheet)}
            onDiscard={() => {
              discardFrom.current = "results";
              setDiscarding(batch.id);
            }}
            onReload={() => void loadIssues(batch.id)}
          />
        ) : null}
        {phase.kind === "importing" ? (
          <div className="flex flex-col gap-4">
            <h2 ref={headingRef} id="stock-step-heading" tabIndex={-1} className="text-xl font-bold tracking-[-0.03em] focus:outline-none">
              {t("import.runningTitle")}
            </h2>
            <ProgressBar
              value={phase.total === null ? null : phase.done}
              max={phase.total ?? 1}
              label={t("import.running", { done: n(phase.done), total: n(phase.total ?? 0) })}
            />
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {phase.total === null ? t("import.starting") : t("import.running", { done: n(phase.done), total: n(phase.total) })}
            </p>
            <p className="max-w-[65ch] text-sm text-muted-foreground">{t("import.keepOpen")}</p>
          </div>
        ) : null}
        {phase.kind === "done" ? (
          <div className="flex flex-col gap-4">
            <h2 ref={headingRef} id="stock-step-heading" tabIndex={-1} className="text-xl font-bold tracking-[-0.03em] focus:outline-none">
              {t("import.doneTitle")}
            </h2>
            <p role="status">
              {t("import.done", {
                created: phase.created,
                createdFormatted: n(phase.created),
                updated: phase.updated,
                updatedFormatted: n(phase.updated),
              })}
            </p>
            {phase.kept > 0 ? <p className="text-sm text-muted-foreground">{t("import.kept", { count: phase.kept, formatted: n(phase.kept) })}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Link href="/inventory" className={buttonVariants({ variant: "neutral" })}>
                {t("import.seeInventory")}
              </Link>
              <Button variant="quiet" onClick={startOver}>
                {t("import.another")}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">{t("import.undoHint")}</p>
          </div>
        ) : null}
      </section>
      <StockHistory
        imports={imports}
        failed={historyFailed}
        busy={busy}
        headingRef={historyHeadingRef}
        onRetry={() => void refreshImports()}
        onUndo={(item) => void openUndo(item)}
        onResume={(item) => void runImport(item.id, null, 0)}
        onDiscard={(item) => {
          discardFrom.current = "history";
          setDiscarding(item.id);
        }}
      />
      <DiscardDialog
        open={discarding !== null}
        onKeep={() => setDiscarding(null)}
        onConfirm={() => {
          if (!discarding) return;
          const id = discarding;
          setDiscarding(null);
          void discard(id);
        }}
        onCloseFocus={() => (discardFrom.current === "history" ? historyHeadingRef : headingRef).current?.focus()}
      />
      <StockUndoDialog
        state={undo}
        onClose={() => setUndo({ kind: "closed" })}
        onRun={() => void runUndo()}
        onCloseFocus={() => historyHeadingRef.current?.focus()}
      />
      {stepUp.dialog}
    </div>
  );
}
