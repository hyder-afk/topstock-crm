"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import {
  checkImport,
  commitImportStep,
  discardImport,
  listImports,
  stageRows,
  startImport,
  type CheckSummary,
  type CommitStep,
} from "@/app/(app)/leads/import/actions";
import { useStepUp } from "@/components/auth/step-up-dialog";
import { useToast } from "@/components/ui/toast";
import { endRun, progressAnnouncer, startRun, useActiveRuns } from "@/components/import/active-runs";
import { CheckStep } from "@/components/import/check-step";
import { ChooseStep } from "@/components/import/choose-step";
import { DiscardDialog } from "@/components/import/discard-dialog";
import { ImportHistory } from "@/components/import/import-history";
import { readMapping } from "@/components/import/mapping-store";
import { MatchStep, type MatchState } from "@/components/import/match-step";
import type { LoadedFile } from "@/components/import/read-file";
import { ImportStopped, attempt, type Runner } from "@/components/import/run";
import { Stepper, type StepId } from "@/components/import/stepper";
import { autoMap, iterChunks, normaliseInSlices, type ImportRow, type NormaliseOptions, type NormalisedRecord } from "@/lib/import";
import type { ImportBatch, ImportErrorCode, ImportIssue } from "@/lib/import-server";
import type { TeamMember } from "@/lib/leads";

// The lead import (Day 3b; design docs/evidence/day3b/design.md): choose a CSV file (it stays in this browser),
// match its columns, check it (problems and duplicates, nothing written to the leads), import, and undo from the
// history. Every write needs an admin with an authenticator code from the last 10 minutes ("Confirm it's you").
export type Phase =
  | { kind: "choose" }
  | { kind: "match" }
  | { kind: "sending"; done: number; total: number }
  | { kind: "checking" }
  | { kind: "review" }
  | { kind: "importing"; done: number; total: number | null }
  | { kind: "done"; added: number; late: number };

export type OpenBatch = {
  id: string;
  filename: string;
  /** The checked file's SHA-256: choosing the same file again on the results screen is checked against it. */
  fileSha256: string | null;
  summary: CheckSummary;
  issues: ImportIssue[] | null; // null while loading
  issuesError: boolean;
  /** After an import that stopped part way: leads already added, and rows still to go. */
  progress: { imported: number; remaining: number } | null;
};

type ErrorKey = ImportErrorCode | "discard_failed";

const stepOf: Record<Phase["kind"], StepId> = {
  choose: "choose",
  match: "match",
  sending: "check",
  checking: "check",
  review: "check",
  importing: "import",
  done: "import",
};

function openBatchOf(item: ImportBatch): OpenBatch {
  return {
    id: item.id,
    filename: item.filename,
    fileSha256: item.file_sha256,
    summary: {
      status: item.status,
      row_count: item.row_count,
      ready: item.issue_counts.ready ?? 0,
      duplicates: item.duplicates,
      rejected: item.rejected,
      issue_counts: item.issue_counts,
    },
    issues: null,
    issuesError: false,
    progress: null,
  };
}

export function ImportWorkspace({
  initialImports,
  team,
  stepUpSeconds,
  timeZone,
  me,
}: {
  initialImports: ImportBatch[] | null;
  team: TeamMember[];
  stepUpSeconds: number;
  timeZone: string;
  me: string;
}) {
  const t = useTranslations("Import");
  const format = useFormatter();
  const queryClient = useQueryClient();
  const toast = useToast();
  const stepUp = useStepUp(stepUpSeconds);
  const activeRuns = useActiveRuns();
  const [phase, setPhase] = useState<Phase>({ kind: "choose" });
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [matchState, setMatchState] = useState<MatchState | null>(null);
  const [batch, setBatch] = useState<OpenBatch | null>(null);
  // The rows cleaned for a check (company names on the results screen), with the import they were sent to.
  const [checked, setChecked] = useState<{ batchId: string; rows: NormalisedRecord[] } | null>(null);
  const [imports, setImports] = useState<ImportBatch[] | null>(initialImports);
  const [historyFailed, setHistoryFailed] = useState(initialImports === null);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // The import whose Discard waits for a yes, and which part of the page asked (focus goes back there).
  const [discarding, setDiscarding] = useState<string | null>(null);
  const discardFrom = useRef<"results" | "history">("results");
  const busy = phase.kind === "sending" || phase.kind === "checking" || phase.kind === "importing";
  const headingRef = useRef<HTMLHeadingElement>(null);
  const historyHeadingRef = useRef<HTMLHeadingElement>(null);
  // Leaving the page within the app does not stop a running check or import (it goes on while the tab is open), but
  // nothing it finds is drawn on a page that is gone. `session` changes whenever the screen moves on to another file
  // or import, so late answers for the one left behind are ignored too.
  const mounted = useRef(false);
  const session = useRef(0);
  const isLive = useCallback((token: number) => mounted.current && session.current === token, []);
  // The import on screen, for answers that arrive after the person moved on (a discard, a file chosen again).
  const shownBatch = useRef<OpenBatch | null>(null);
  useEffect(() => {
    shownBatch.current = batch;
  }, [batch]);
  // Imports from checks that failed and could not be thrown away at once (the connection was down, or no code): the
  // next Check throws them away first, so they never pile up against the limit of 3 unfinished imports.
  const leftovers = useRef(new Set<string>());

  const runner: Runner = useMemo(() => ({ requireFresh: stepUp.requireFresh }), [stepUp.requireFresh]);
  const n = useCallback((value: number) => format.number(value), [format]);
  const announce = useCallback((text: string) => {
    if (mounted.current) setAnnouncement(text);
  }, []);

  const refreshImports = useCallback(async () => {
    let ok = false;
    try {
      const result = await listImports({});
      if (result.ok && mounted.current) setImports(result.data);
      ok = result.ok;
    } catch {
      // Shown below: the list stays as it was, with "Try again".
    }
    if (mounted.current) setHistoryFailed(!ok);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Coming back to the page (or an import that was still running in this tab finishing): Past imports shows where
  // every import really stands.
  const lastRuns = useRef(activeRuns);
  useEffect(() => {
    const ended = [...lastRuns.current].some((id) => !activeRuns.has(id));
    lastRuns.current = activeRuns;
    if (ended) void refreshImports();
  }, [activeRuns, refreshImports]);
  useEffect(() => {
    let current = true;
    listImports({})
      .then((result) => {
        if (!current || !result.ok) return;
        setImports(result.data);
        setHistoryFailed(false);
      })
      .catch(() => {
        // The list from the page load stays.
      });
    return () => {
      current = false;
    };
  }, []);

  // Closing or reloading the tab while rows are being sent or imported would pause the work: ask first. This is the one
  // native popup the app keeps (Haider, 15 Oct 2026, docs/log.md): no page can replace the browser's "Leave site?" once
  // the tab is closing. scripts/check-native-controls.mjs allows exactly this one use (ALLOWED).
  useEffect(() => {
    if (!busy) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [busy]);

  // Each new step (and each step returned to after a failure) moves focus to its heading: screen readers hear where
  // they are, and the keyboard never starts again from the top of the page.
  // The step heading takes the focus once React has drawn the screen this change belongs to (an effect after that
  // commit), not on the next frame: a busy main thread (a large file just read) can run the frame first, which would
  // focus the heading that is about to go and leave the focus on the page.
  const [focusRequest, setFocusRequest] = useState(0);
  const focusHeading = useCallback(() => setFocusRequest((n) => n + 1), []);
  useEffect(() => {
    if (focusRequest > 0) headingRef.current?.focus();
  }, [focusRequest]);

  const fail = useCallback(
    (cause: unknown, back: Phase) => {
      const code = cause instanceof ImportStopped ? cause.code : "unavailable";
      setError(code === "cancelled" ? null : code);
      setPhase(back);
      focusHeading();
    },
    [focusHeading],
  );

  const loadIssues = useCallback(
    async (batchId: string) => {
      const all: ImportIssue[] = [];
      try {
        for (let after = 0; ; ) {
          const response = await fetch(`/api/imports/${batchId}/issues?after=${after}`, { cache: "no-store" });
          if (response.status === 403) {
            const body = (await response.json().catch(() => null)) as { error?: string } | null;
            if (body?.error === "step_up" && (await stepUp.requireFresh())) continue;
            throw new Error("forbidden");
          }
          if (!response.ok) throw new Error("unavailable");
          const { issues } = (await response.json()) as { issues: ImportIssue[] };
          all.push(...issues);
          if (issues.length < 1000) break;
          after = issues[issues.length - 1].row_no;
        }
        setBatch((b) => (b && b.id === batchId ? { ...b, issues: all, issuesError: false } : b));
      } catch {
        setBatch((b) => (b && b.id === batchId ? { ...b, issues: null, issuesError: true } : b));
      }
    },
    [stepUp],
  );

  // Check: clean every row here, send them in chunks, let the database find problems and duplicates. A check that
  // stops part way is thrown away (best effort), so "Check file" again starts a fresh one.
  const runCheck = useCallback(
    async (rows: NormalisedRecord[], zone: string) => {
      if (!file) return;
      const token = session.current;
      if (!(await stepUp.ensureFresh(180)) || !isLive(token)) return;
      setError(null);
      for (const id of [...leftovers.current]) {
        try {
          await attempt(runner, () => discardImport({ batchId: id }));
          leftovers.current.delete(id);
        } catch (cause) {
          // Gone already, or no longer a check (someone imported or discarded it): nothing left to throw away.
          if (cause instanceof ImportStopped && ["not_found", "not_ready", "bad_transition"].includes(cause.code)) {
            leftovers.current.delete(id);
          }
        }
      }
      const payloads: ImportRow[] = rows.map((r) => r.payload);
      const total = payloads.length;
      const sendingProgress = progressAnnouncer(announce);
      setPhase({ kind: "sending", done: 0, total });
      sendingProgress(0, total, t("check.sending", { done: n(0), total: n(total) }));
      focusHeading();
      let batchId: string | null = null;
      try {
        const created = await attempt(runner, () =>
          startImport({
            filename: file.name,
            sha256: file.sha256,
            rowCount: file.parsed.rowCount,
            lastRowNo: file.parsed.lastRowNo,
            timeZone: zone,
          }),
        );
        batchId = created.batchId;
        startRun(created.batchId);
        let sent = 0;
        // Each group is measured just before it is sent, so the page never pauses to measure them all.
        for (const chunk of iterChunks(payloads)) {
          // The screen moved on to another file or import: this check is abandoned.
          if (mounted.current && session.current !== token) throw new ImportStopped("cancelled");
          await attempt(runner, () => stageRows({ batchId: created.batchId, rows: chunk }));
          sent += chunk.length;
          if (isLive(token)) {
            setPhase({ kind: "sending", done: sent, total });
            sendingProgress(sent, total, t("check.sending", { done: n(sent), total: n(total) }));
          }
        }
        if (isLive(token)) {
          setPhase({ kind: "checking" });
          announce(t("check.duplicates"));
        }
        const summary = await attempt(runner, () => checkImport({ batchId: created.batchId }));
        // Left meanwhile: the check waits in Past imports ("Checked, not imported").
        if (!isLive(token)) return;
        setChecked({ batchId: created.batchId, rows });
        setBatch({ id: created.batchId, filename: file.name, fileSha256: file.sha256, summary, issues: null, issuesError: false, progress: null });
        setPhase({ kind: "review" });
        focusHeading();
        void loadIssues(created.batchId);
      } catch (cause) {
        if (isLive(token)) fail(cause, { kind: "match" });
        if (batchId) {
          const thrown = await discardImport({ batchId }).catch(() => null);
          if (!thrown?.ok) leftovers.current.add(batchId);
        }
      } finally {
        if (batchId) endRun(batchId);
        void refreshImports();
      }
    },
    [file, runner, stepUp, isLive, announce, t, n, focusHeading, refreshImports, loadIssues, fail],
  );

  // Import: the ready rows go in 1,000 per call (fewer after a timeout) until none are left. Safe to resume: the
  // counts come from the database (imported_total), so a resumed import shows everything already added. If it stops,
  // the screen goes back to `back` (where the person was).
  const runImport = useCallback(
    async (target: OpenBatch, start: { done: number; total: number | null }, back: { phase: Phase; batch: OpenBatch | null }) => {
      const token = session.current;
      if (!(await stepUp.ensureFresh(180)) || !isLive(token)) return;
      setError(null);
      setBatch(target);
      let size = 1000;
      let late = 0;
      let done = start.done;
      let total = start.total;
      let last: CommitStep | null = null;
      const importingProgress = progressAnnouncer(announce);
      const say = () =>
        total
          ? t("check.importing", { done, doneFormatted: n(done), total: n(total) })
          : t("check.importingCount", { done, doneFormatted: n(done) });
      setPhase({ kind: "importing", done, total });
      importingProgress(done, total ?? 0, say());
      focusHeading();
      startRun(target.id);
      try {
        for (;;) {
          let step: CommitStep;
          try {
            step = await attempt(runner, () => commitImportStep({ batchId: target.id, size }));
          } catch (cause) {
            if (cause instanceof ImportStopped && cause.code === "timeout" && size > 250) {
              size = Math.max(250, Math.floor(size / 2));
              continue;
            }
            throw cause;
          }
          last = step;
          late += step.late_duplicates;
          done = step.imported_total;
          total = step.imported_total + step.remaining;
          if (isLive(token)) {
            setPhase({ kind: "importing", done, total });
            importingProgress(done, total, say());
          }
          if (step.status === "imported") break;
        }
        if (isLive(token)) {
          setPhase({ kind: "done", added: done, late });
          focusHeading();
        }
        void queryClient.invalidateQueries({ queryKey: ["leads"] });
      } catch (cause) {
        if (isLive(token)) {
          const progress = last ? { imported: last.imported_total, remaining: last.remaining } : target.progress;
          const before = back.batch;
          if (before && before.id === target.id) {
            // The same import: keep what loaded meanwhile (its rows), with how far the import got.
            setBatch((b) => (b && b.id === target.id ? { ...b, progress } : { ...before, progress }));
          } else {
            // Back to another import: its rows may have arrived while this one was shown, so load them again.
            setBatch(before);
            if (before && before.issues === null && !before.issuesError) void loadIssues(before.id);
          }
          fail(cause, back.phase);
        }
      } finally {
        endRun(target.id);
        void refreshImports();
      }
    },
    [runner, stepUp, isLive, announce, t, n, focusHeading, queryClient, refreshImports, loadIssues, fail],
  );

  const startOver = useCallback(() => {
    session.current += 1;
    setPhase({ kind: "choose" });
    setFile(null);
    setMatchState(null);
    setBatch(null);
    setChecked(null);
    setError(null);
    focusHeading();
  }, [focusHeading]);

  const discard = useCallback(
    async (batchId: string) => {
      // The Discard button that asked was in the dialog that has just closed: after a code, focus goes to the heading
      // of the part of the page that asked.
      const focusTarget = () => (discardFrom.current === "history" ? historyHeadingRef : headingRef).current;
      if (!(await stepUp.ensureFresh(60, focusTarget)) || !mounted.current) return;
      try {
        await attempt(runner, () => discardImport({ batchId }));
        if (!mounted.current) return;
        toast.show(t("toast.discarded"));
        if (shownBatch.current?.id === batchId) startOver();
      } catch (cause) {
        if (!mounted.current) return;
        const code = cause instanceof ImportStopped ? cause.code : "unavailable";
        setError(code === "cancelled" ? null : code === "unavailable" || code === "timeout" ? "discard_failed" : code);
      } finally {
        void refreshImports();
      }
    },
    [runner, stepUp, toast, t, refreshImports, startOver],
  );

  // From the history: review a checked import (rows without the file; choosing it again adds the names), or resume
  // a paused one.
  const openFromHistory = useCallback(
    async (item: ImportBatch, action: "review" | "resume") => {
      setError(null);
      if (action === "resume") {
        // The code is asked for (if needed) before the screen changes; if the import stops, it comes back here.
        await runImport(openBatchOf(item), { done: item.imported, total: null }, { phase, batch });
        return;
      }
      session.current += 1;
      const token = session.current;
      // Opened on purpose: a check that seemed to fail is no longer thrown away at the next Check.
      leftovers.current.delete(item.id);
      setBatch(openBatchOf(item));
      setFile((f) => (f && f.sha256 === item.file_sha256 ? f : null));
      setPhase({ kind: "review" });
      focusHeading();
      if (await stepUp.ensureFresh(60)) {
        if (isLive(token)) void loadIssues(item.id);
      } else if (isLive(token)) {
        // No code: the rows show their error state with "Try again" (which asks again).
        setBatch((b) => (b && b.id === item.id ? { ...b, issuesError: true } : b));
      }
    },
    [phase, batch, runImport, loadIssues, stepUp, isLive, focusHeading],
  );

  // Stable, so the matching screen's live counts only start again when a choice changes.
  const normaliseFile = useCallback(
    (options: NormaliseOptions, signal: AbortSignal) =>
      file ? normaliseInSlices(file.parsed.records, options, { sliceSize: 500, signal }) : Promise.resolve([]),
    [file],
  );

  const sameFileBefore = useMemo(
    () => (file ? (imports ?? []).find((i) => i.file_sha256 === file.sha256 && i.status === "imported") ?? null : null),
    [file, imports],
  );

  // The company name column of the file in memory: the matching chosen on this screen, else the one remembered for
  // this header row, else the suggestion (used for names when the cleaned rows are not in memory).
  const nameColumn = useMemo(() => {
    if (!file) return -1;
    const chosen = matchState?.mapping.indexOf("name") ?? -1;
    if (chosen >= 0) return chosen;
    return (readMapping(file.headerKey, file.parsed.headers.length) ?? autoMap(file.parsed.headers).targets).indexOf("name");
  }, [file, matchState]);

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
      <section aria-labelledby="import-step-heading" className="flex min-w-0 flex-col gap-6 rounded-lg bg-card p-4 sm:p-8">
        <Stepper current={stepOf[phase.kind]} />
        {error ? (
          <div role="alert" className="flex items-start gap-2 rounded-md bg-muted px-4 py-3">
            <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-status-red" />
            <p>{t(`errors.${error}`)}</p>
          </div>
        ) : null}
        {phase.kind === "choose" ? (
          <ChooseStep
            headingRef={headingRef}
            announce={announce}
            onLoaded={(loaded) => {
              session.current += 1;
              setError(null);
              setFile(loaded);
              setMatchState(null);
              setChecked(null);
              setPhase({ kind: "match" });
              focusHeading();
            }}
          />
        ) : null}
        {phase.kind === "match" && file ? (
          <MatchStep
            headingRef={headingRef}
            file={file}
            team={team}
            defaultTimeZone={timeZone}
            sameFileBefore={sameFileBefore}
            saved={matchState}
            onStateChange={setMatchState}
            onBack={startOver}
            onCheck={(rows, zone) => void runCheck(rows, zone)}
            normalise={normaliseFile}
          />
        ) : null}
        {phase.kind !== "choose" && phase.kind !== "match" ? (
          <CheckStep
            headingRef={headingRef}
            phase={phase}
            batch={batch}
            file={file}
            records={checked && batch && checked.batchId === batch.id ? checked.rows : null}
            nameColumn={nameColumn}
            onImport={() => {
              if (!batch) return;
              const total = batch.progress ? batch.progress.imported + batch.progress.remaining : batch.summary.ready;
              void runImport(batch, { done: batch.progress?.imported ?? 0, total }, { phase: { kind: "review" }, batch });
            }}
            onDiscard={() => {
              if (!batch) return;
              discardFrom.current = "results";
              setDiscarding(batch.id);
            }}
            onRetryIssues={() => batch && void loadIssues(batch.id)}
            onStartOver={startOver}
            onFileChosen={(loaded) => {
              // Only for the import still on screen (a late read for another one is dropped).
              if (shownBatch.current?.fileSha256 !== loaded.sha256) return;
              setFile(loaded);
              setMatchState(null);
            }}
          />
        ) : null}
      </section>
      <ImportHistory
        imports={imports}
        failed={historyFailed}
        onRetry={() => void refreshImports()}
        headingRef={historyHeadingRef}
        me={me}
        busy={busy}
        running={activeRuns}
        stepUp={stepUp}
        runner={runner}
        onOpen={(item, action) => void openFromHistory(item, action)}
        onDiscard={(item) => {
          discardFrom.current = "history";
          setDiscarding(item.id);
        }}
        onChanged={() => {
          void refreshImports();
          void queryClient.invalidateQueries({ queryKey: ["leads"] });
        }}
      />
      <DiscardDialog
        open={discarding !== null}
        onKeep={() => setDiscarding(null)}
        onConfirm={() => {
          if (!discarding) return;
          setDiscarding(null);
          void discard(discarding);
        }}
        onCloseFocus={() => (discardFrom.current === "history" ? historyHeadingRef : headingRef).current?.focus()}
      />
      {/* Progress for screen readers, about every tenth of the work (the visible counts change with every chunk). */}
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      {stepUp.dialog}
    </div>
  );
}
