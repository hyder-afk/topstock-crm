"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { previewUndo, undoImportStep, type UndoPreview } from "@/app/(app)/leads/import/actions";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, phoneSheet } from "@/components/ui/dialog";
import { endRun, progressAnnouncer, startRun } from "@/components/import/active-runs";
import { ProgressBar } from "@/components/import/progress";
import { ImportStopped, attempt, type Runner } from "@/components/import/run";
import type { ImportBatch, ImportErrorCode } from "@/lib/import-server";
import { cn } from "@/lib/utils";

type StepUp = { ensureFresh: (minSeconds?: number) => Promise<boolean> };

const tone: Record<ImportBatch["status"], string> = {
  staged: "bg-status-amber",
  dry_run: "bg-status-amber",
  committing: "bg-status-amber",
  imported: "bg-status-green",
  rolling_back: "bg-status-amber",
  rolled_back: "bg-muted-foreground",
  discarded: "bg-muted-foreground",
};

// Long file names keep their start and their end ("Leads export 2026-10…final.csv").
function middleTruncate(name: string, max = 34) {
  return name.length <= max ? name : `${name.slice(0, max - 13)}…${name.slice(-12)}`;
}

// "Past imports": every file imported or started, newest first, with what can still be done with it. An import
// still running in this tab (its page was left meanwhile) says so and offers nothing until it has finished.
export function ImportHistory({
  imports,
  failed,
  onRetry,
  headingRef,
  me,
  busy,
  running,
  stepUp,
  runner,
  onOpen,
  onDiscard,
  onChanged,
}: {
  imports: ImportBatch[] | null;
  failed: boolean;
  onRetry: () => void;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  me: string;
  busy: boolean;
  running: ReadonlySet<string>;
  stepUp: StepUp;
  runner: Runner;
  onOpen: (item: ImportBatch, action: "review" | "resume") => void;
  onDiscard: (item: ImportBatch) => void;
  onChanged: () => void;
}) {
  const t = useTranslations("Import.history");
  const format = useFormatter();
  const [undoing, setUndoing] = useState<ImportBatch | null>(null);
  const undoOpener = useRef<HTMLElement | null>(null);

  const failedNotice = (
    <div role="alert" className="flex flex-col items-start gap-2">
      <p className="text-muted-foreground">{t("error")}</p>
      <Button variant="quiet" onClick={onRetry}>
        {t("retry")}
      </Button>
    </div>
  );

  return (
    <aside aria-labelledby="import-history-heading" className="flex min-w-0 flex-col gap-4 rounded-lg bg-card p-4 sm:p-6">
      <h2
        ref={headingRef}
        id="import-history-heading"
        tabIndex={-1}
        className="text-lg font-bold tracking-[-0.03em] focus:outline-none"
      >
        {t("title")}
      </h2>
      {imports === null ? (
        failedNotice
      ) : (
        <>
          {failed ? failedNotice : null}
          {imports.length === 0 ? (
            <p className="text-muted-foreground">{t("empty")}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {imports.map((item) => {
                const mine = item.uploaded_by === me;
                const who = [item.uploader_first_name, item.uploader_last_name].filter(Boolean).join(" ") || t("someone");
                const here = running.has(item.id);
                return (
                  <li key={item.id} className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
                    <p className="font-bold wrap-anywhere">
                      <span className="sr-only">{item.filename}</span>
                      <span aria-hidden="true">{middleTruncate(item.filename)}</span>
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {t("when", { date: format.dateTime(new Date(item.created_at), { dateStyle: "medium", timeStyle: "short" }), who })}
                    </p>
                    <span className="inline-flex w-fit items-center gap-1.5 rounded-sm bg-muted px-2 py-0.5 text-xs">
                      <span aria-hidden="true" className={cn("size-1.5 rounded-full", here ? "bg-status-amber" : tone[item.status])} />
                      {here
                        ? t("status.running")
                        : item.status === "rolled_back"
                          ? t("status.rolled_back", { count: item.kept, formatted: format.number(item.kept) })
                          : t(`status.${item.status}`)}
                    </span>
                    <Counts item={item} />
                    {here ? null : (
                      <div className="flex flex-wrap gap-x-4 gap-y-1">
                        {item.status === "dry_run" && mine ? (
                          <Button variant="link" disabled={busy} onClick={() => onOpen(item, "review")}>
                            {t("review")}
                          </Button>
                        ) : null}
                        {item.status === "committing" && mine ? (
                          <Button variant="link" disabled={busy} onClick={() => onOpen(item, "resume")}>
                            {t("resume")}
                          </Button>
                        ) : null}
                        {item.status === "imported" ? (
                          <Link href={`/leads?batch=${item.id}&sort=created`} className={buttonVariants({ variant: "link" })}>
                            {t("seeLeads")}
                          </Link>
                        ) : null}
                        {item.status === "committing" || item.status === "imported" || item.status === "rolling_back" ? (
                          <Button
                            variant="link"
                            disabled={busy}
                            onClick={(event) => {
                              undoOpener.current = event.currentTarget;
                              setUndoing(item);
                            }}
                          >
                            {item.status === "rolling_back" ? t("resumeUndo") : t("undo")}
                          </Button>
                        ) : null}
                        {item.status === "staged" || item.status === "dry_run" ? (
                          <Button variant="link" disabled={busy} onClick={() => onDiscard(item)}>
                            {t("discard")}
                          </Button>
                        ) : null}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      <UndoDialog
        key={undoing?.id ?? "none"}
        batch={undoing}
        stepUp={stepUp}
        runner={runner}
        onClose={() => setUndoing(null)}
        onChanged={onChanged}
        onCloseFocus={(finished) => {
          // Back to the Undo button when it is still there; after a finished undo it is gone, so to this list's heading.
          const opener = undoOpener.current;
          if (!finished && opener?.isConnected) opener.focus();
          else headingRef.current?.focus();
        }}
      />
    </aside>
  );
}

function Counts({ item }: { item: ImportBatch }) {
  const t = useTranslations("Import.history");
  const format = useFormatter();
  const c = item.issue_counts;
  const parts: string[] = [];
  // While an import or its undo is paused, `imported` is the number of leads it has added so far.
  if (item.status === "imported" || item.status === "rolled_back" || item.status === "rolling_back" || item.status === "committing") {
    parts.push(t("counts.added", { count: item.imported, formatted: format.number(item.imported) }));
  } else if (item.status === "dry_run") {
    parts.push(t("counts.ready", { count: c.ready ?? 0, formatted: format.number(c.ready ?? 0) }));
  } else {
    parts.push(t("counts.rows", { count: item.row_count, formatted: format.number(item.row_count) }));
  }
  if (item.status !== "staged" && item.status !== "discarded") {
    if (c.duplicate_existing) parts.push(t("counts.existing", { count: c.duplicate_existing, formatted: format.number(c.duplicate_existing) }));
    if (c.duplicate_file) parts.push(t("counts.repeated", { count: c.duplicate_file, formatted: format.number(c.duplicate_file) }));
    if (item.rejected) parts.push(t("counts.rejected", { count: item.rejected, formatted: format.number(item.rejected) }));
  }
  return <p className="font-mono text-xs text-muted-foreground">{parts.join(" · ")}</p>;
}

type UndoState =
  | { kind: "loading" }
  | { kind: "confirm"; preview: UndoPreview }
  | { kind: "running"; removed: number; total: number }
  | { kind: "done"; removed: number; kept: number }
  | { kind: "error"; code: ImportErrorCode; during: "preview" | "run" };

const codeOf = (cause: unknown): ImportErrorCode =>
  cause instanceof ImportStopped && cause.code !== "cancelled" ? cause.code : "unavailable";

// Undo an import: it removes only the leads nobody has worked on since (a call, note, contact, deal or any change,
// including a new owner); the others stay. The numbers are shown before anything happens. Progress, the result and
// errors are announced (a live region present from the first open), and the title says where it stands.
function UndoDialog({
  batch,
  stepUp,
  runner,
  onClose,
  onChanged,
  onCloseFocus,
}: {
  batch: ImportBatch | null;
  stepUp: StepUp;
  runner: Runner;
  onClose: () => void;
  onChanged: () => void;
  onCloseFocus: (finished: boolean) => void;
}) {
  const t = useTranslations("Import.undo");
  const te = useTranslations("Import.errors");
  const format = useFormatter();
  // The dialog is keyed by the import, so each one starts here with its numbers loading.
  const [state, setState] = useState<UndoState>({ kind: "loading" });
  const [count, setCount] = useState(0); // bumped to count the numbers again
  const [live, setLive] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);
  const n = (value: number) => format.number(value);
  const batchId = batch?.id ?? null;

  useEffect(() => {
    if (!batchId) return;
    let current = true;
    attempt(runner, () => previewUndo({ batchId }))
      .then((preview) => current && setState({ kind: "confirm", preview }))
      .catch((cause: unknown) => {
        if (current) setState({ kind: "error", code: codeOf(cause), during: "preview" });
      });
    return () => {
      current = false;
    };
  }, [batchId, runner, count]);

  // When it has finished or stopped, focus goes to Close (the Remove button that had it is gone).
  const ended = state.kind === "done" || state.kind === "error";
  useEffect(() => {
    if (ended) closeRef.current?.focus();
  }, [ended]);

  const errorText = (code: ImportErrorCode, during: "preview" | "run") =>
    code === "unavailable" || code === "timeout" ? t(during === "preview" ? "errors.preview" : `errors.${code}`) : te(code);

  const run = async () => {
    if (!batch || state.kind !== "confirm") return;
    const { tagged, removable } = state.preview;
    if (!(await stepUp.ensureFresh(180))) return;
    let removed = 0;
    const progress = progressAnnouncer(setLive);
    const say = () => t("running", { done: removed, doneFormatted: n(removed), total: n(removable) });
    setState({ kind: "running", removed, total: removable });
    progress(0, removable, say());
    startRun(batch.id);
    try {
      for (;;) {
        const step = await attempt(runner, () => undoImportStep({ batchId: batch.id }));
        removed = Math.min(removable, removed + step.removed_now);
        setState({ kind: "running", removed, total: removable });
        progress(removed, removable, say());
        if (step.status === "rolled_back") {
          const kept = step.kept ?? 0;
          // Counted from what is left, so an answer lost on the way does not make the number short.
          const total = Math.max(removed, tagged - kept);
          setState({ kind: "done", removed: total, kept });
          setLive(t("done", { removed: total, removedFormatted: n(total), kept, keptFormatted: n(kept) }));
          break;
        }
      }
    } catch (cause) {
      if (cause instanceof ImportStopped && cause.code === "cancelled") {
        // The code was not confirmed: back to the numbers (counted again), nothing alarming.
        setLive("");
        setState({ kind: "loading" });
        setCount((c) => c + 1);
      } else {
        const code = codeOf(cause);
        setState({ kind: "error", code, during: "run" });
        setLive(errorText(code, "run"));
      }
    } finally {
      endRun(batch.id);
      onChanged();
    }
  };

  const running = state.kind === "running";
  const title =
    state.kind === "running"
      ? t("runningTitle")
      : state.kind === "done"
        ? t("doneTitle")
        : state.kind === "error"
          ? t(state.during === "run" ? "pausedTitle" : "errorTitle")
          : t("title");
  return (
    <Dialog open={batch !== null} onOpenChange={(open) => (!open && !running ? onClose() : null)}>
      <DialogContent
        className={cn(phoneSheet, "sm:w-[min(520px,calc(100%-32px))]")}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onCloseFocus(state.kind === "done");
        }}
      >
        <div className="flex flex-col gap-5 p-6">
          <DialogTitle className="text-xl font-bold tracking-[-0.03em] text-balance">{title}</DialogTitle>
          <DialogDescription className="text-muted-foreground wrap-anywhere">
            {state.kind === "confirm" && batch
              ? t("body", {
                  file: batch.filename,
                  date: format.dateTime(new Date(batch.imported_at ?? batch.created_at), { dateStyle: "medium" }),
                  removable: state.preview.removable,
                  removableFormatted: n(state.preview.removable),
                  kept: state.preview.kept,
                  keptFormatted: n(state.preview.kept),
                })
              : state.kind === "running"
                ? t("runningBody")
                : state.kind === "done"
                  ? t("done", { removed: state.removed, removedFormatted: n(state.removed), kept: state.kept, keptFormatted: n(state.kept) })
                  : state.kind === "error"
                    ? errorText(state.code, state.during)
                    : t("loading")}
          </DialogDescription>
          {state.kind === "running" ? (
            <div className="flex flex-col gap-2">
              <ProgressBar value={state.removed} max={Math.max(state.total, 1)} label={t("runningTitle")} />
              <p className="text-sm text-muted-foreground">
                {t("running", { done: state.removed, doneFormatted: n(state.removed), total: n(state.total) })}
              </p>
            </div>
          ) : null}
          <p className="sr-only" aria-live="polite">
            {live}
          </p>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            {state.kind === "confirm" ? (
              <>
                <Button variant="quiet" onClick={onClose}>
                  {t("keep")}
                </Button>
                <Button variant="neutral" onClick={() => void run()}>
                  {state.preview.removable > 0
                    ? t("remove", { count: state.preview.removable, formatted: n(state.preview.removable) })
                    : t("finish")}
                </Button>
              </>
            ) : running ? null : (
              <Button ref={closeRef} variant="quiet" onClick={onClose}>
                {t("close")}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
