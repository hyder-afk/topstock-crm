"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import {
  checkImport,
  commitImportStep,
  discardImport,
  listImports,
  stageRows,
  startImport,
  type CheckSummary,
} from "@/app/(app)/leads/import/actions";
import { useStepUp } from "@/components/auth/step-up-dialog";
import { useToast } from "@/components/ui/toast";
import { CheckStep } from "@/components/import/check-step";
import { ChooseStep, type LoadedFile } from "@/components/import/choose-step";
import { ImportHistory } from "@/components/import/import-history";
import { MatchStep, type MatchChoices } from "@/components/import/match-step";
import { ImportStopped, attempt, type Runner } from "@/components/import/run";
import { Stepper, type StepId } from "@/components/import/stepper";
import { iterChunks, normaliseInSlices, type ImportRow, type NormalisedRecord } from "@/lib/import";
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
  summary: CheckSummary;
  issues: ImportIssue[] | null; // null while loading
  issuesError: boolean;
};

const stepOf: Record<Phase["kind"], StepId> = {
  choose: "choose",
  match: "match",
  sending: "check",
  checking: "check",
  review: "check",
  importing: "import",
  done: "import",
};

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
  const queryClient = useQueryClient();
  const toast = useToast();
  const stepUp = useStepUp(stepUpSeconds);
  const [phase, setPhase] = useState<Phase>({ kind: "choose" });
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [choices, setChoices] = useState<MatchChoices | null>(null);
  const [batch, setBatch] = useState<OpenBatch | null>(null);
  // An import started earlier whose upload did not finish: continuing needs the same file again.
  const [resume, setResume] = useState<ImportBatch | null>(null);
  const [imports, setImports] = useState<ImportBatch[] | null>(initialImports);
  const [error, setError] = useState<ImportErrorCode | null>(null);
  const records = useRef<NormalisedRecord[]>([]);
  const busy = phase.kind === "sending" || phase.kind === "checking" || phase.kind === "importing";
  const headingRef = useRef<HTMLHeadingElement>(null);

  const runner: Runner = useMemo(() => ({ requireFresh: stepUp.requireFresh }), [stepUp.requireFresh]);

  const refreshImports = useCallback(async () => {
    try {
      const result = await listImports({});
      if (result.ok) setImports(result.data);
    } catch {
      // History stays as it was; the next action refreshes it again.
    }
  }, []);

  // Leaving the page while rows are being sent or imported would pause the import: ask first.
  useEffect(() => {
    if (!busy) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [busy]);

  // Each new step moves focus to its heading (screen readers hear where they are).
  const focusHeading = useCallback(() => requestAnimationFrame(() => headingRef.current?.focus()), []);

  const fail = useCallback(
    (cause: unknown, back: Phase) => {
      const code = cause instanceof ImportStopped ? cause.code : "unavailable";
      if (code !== "cancelled") setError(code);
      setPhase(back);
    },
    [],
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

  // Check: clean every row here, send them in chunks, let the database find problems and duplicates.
  const runCheck = useCallback(
    async (rows: NormalisedRecord[]) => {
      if (!file || !(await stepUp.ensureFresh(180))) return;
      setError(null);
      records.current = rows;
      const payloads: ImportRow[] = rows.map((r) => r.payload);
      setPhase({ kind: "sending", done: 0, total: payloads.length });
      focusHeading();
      try {
        const batchId =
          resume?.id ??
          (
            await attempt(runner, () =>
              startImport({
                filename: file.name,
                sha256: file.sha256,
                rowCount: file.parsed.rowCount,
                lastRowNo: file.parsed.lastRowNo,
                timeZone: choices?.timeZone ?? timeZone,
              }),
            )
          ).batchId;
        let sent = 0;
        // Each group is measured just before it is sent, so the page never pauses to measure them all.
        for (const chunk of iterChunks(payloads)) {
          await attempt(runner, () => stageRows({ batchId, rows: chunk }));
          sent += chunk.length;
          setPhase({ kind: "sending", done: sent, total: payloads.length });
        }
        setPhase({ kind: "checking" });
        const summary = await attempt(runner, () => checkImport({ batchId }));
        setResume(null);
        setBatch({ id: batchId, filename: file.name, summary, issues: null, issuesError: false });
        setPhase({ kind: "review" });
        focusHeading();
        void refreshImports();
        void loadIssues(batchId);
      } catch (cause) {
        fail(cause, { kind: "match" });
        void refreshImports();
      }
    },
    [file, choices, timeZone, resume, runner, stepUp, focusHeading, refreshImports, loadIssues, fail],
  );

  // Import: the ready rows go in 1,000 per call (fewer after a timeout) until none are left. Safe to resume.
  const runImport = useCallback(
    async (batchId: string, expected: number | null) => {
      if (!(await stepUp.ensureFresh(180))) return;
      setError(null);
      let size = 1000;
      let added = 0;
      let late = 0;
      setPhase({ kind: "importing", done: 0, total: expected });
      focusHeading();
      try {
        for (;;) {
          let step;
          try {
            step = await attempt(runner, () => commitImportStep({ batchId, size }));
          } catch (cause) {
            if (cause instanceof ImportStopped && cause.code === "timeout" && size > 250) {
              size = Math.max(250, Math.floor(size / 2));
              continue;
            }
            throw cause;
          }
          added += step.imported_now;
          late += step.late_duplicates;
          setPhase({ kind: "importing", done: added, total: expected ?? added + step.remaining });
          if (step.status === "imported") break;
        }
        setPhase({ kind: "done", added, late });
        focusHeading();
        void queryClient.invalidateQueries({ queryKey: ["leads"] });
      } catch (cause) {
        fail(cause, batch ? { kind: "review" } : { kind: "choose" });
      } finally {
        void refreshImports();
      }
    },
    [batch, runner, stepUp, focusHeading, queryClient, refreshImports, fail],
  );

  const startOver = useCallback(() => {
    setPhase({ kind: "choose" });
    setFile(null);
    setChoices(null);
    setBatch(null);
    setResume(null);
    setError(null);
    records.current = [];
    focusHeading();
  }, [focusHeading]);

  const discard = useCallback(
    async (batchId: string) => {
      if (!(await stepUp.ensureFresh(60))) return;
      try {
        await attempt(runner, () => discardImport({ batchId }));
        toast.show(t("toast.discarded"));
        if (batch?.id === batchId) startOver();
      } catch (cause) {
        setError(cause instanceof ImportStopped && cause.code !== "cancelled" ? cause.code : null);
      } finally {
        void refreshImports();
      }
    },
    [batch, runner, stepUp, toast, t, refreshImports, startOver],
  );

  // From the history: review a checked import (no file needed), resume a paused one, or continue an upload.
  const openFromHistory = useCallback(
    async (item: ImportBatch, action: "review" | "resume" | "continue") => {
      setError(null);
      if (action === "continue") {
        setResume(item);
        setFile(null);
        setBatch(null);
        setPhase({ kind: "choose" });
        focusHeading();
        return;
      }
      const summary: CheckSummary = {
        status: item.status,
        row_count: item.row_count,
        ready: item.issue_counts.ready ?? 0,
        duplicates: item.duplicates,
        rejected: item.rejected,
        issue_counts: item.issue_counts,
      };
      setBatch({ id: item.id, filename: item.filename, summary, issues: null, issuesError: false });
      if (action === "resume") {
        await runImport(item.id, null);
        return;
      }
      setFile((f) => (f && f.sha256 === item.file_sha256 ? f : null));
      setPhase({ kind: "review" });
      focusHeading();
      if (await stepUp.ensureFresh(60)) void loadIssues(item.id);
    },
    [runImport, loadIssues, stepUp, focusHeading],
  );

  const sameFileBefore = useMemo(
    () => (file ? (imports ?? []).find((i) => i.file_sha256 === file.sha256 && i.status === "imported") ?? null : null),
    [file, imports],
  );

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
            resume={resume}
            onCancelResume={() => setResume(null)}
            onLoaded={(loaded) => {
              setError(null);
              setFile(loaded);
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
            onChange={setChoices}
            onBack={startOver}
            onCheck={(rows) => void runCheck(rows)}
            normalise={(c) => normaliseInSlices(file.parsed.records, c)}
          />
        ) : null}
        {phase.kind !== "choose" && phase.kind !== "match" ? (
          <CheckStep
            headingRef={headingRef}
            phase={phase}
            batch={batch}
            file={file}
            records={records.current}
            onImport={() => batch && void runImport(batch.id, batch.summary.ready)}
            onDiscard={() => batch && void discard(batch.id)}
            onRetryIssues={() => batch && void loadIssues(batch.id)}
            onStartOver={startOver}
          />
        ) : null}
      </section>
      <ImportHistory
        imports={imports}
        me={me}
        busy={busy}
        stepUp={stepUp}
        runner={runner}
        onOpen={(item, action) => void openFromHistory(item, action)}
        onDiscard={(item) => void discard(item.id)}
        onChanged={() => {
          void refreshImports();
          void queryClient.invalidateQueries({ queryKey: ["leads"] });
        }}
      />
      {stepUp.dialog}
    </div>
  );
}
