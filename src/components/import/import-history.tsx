"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { previewUndo, undoImportStep, type UndoPreview } from "@/app/(app)/leads/import/actions";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, phoneSheet } from "@/components/ui/dialog";
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

// "Past imports": every file imported or started, newest first, with what can still be done with it.
export function ImportHistory({
  imports,
  me,
  busy,
  stepUp,
  runner,
  onOpen,
  onDiscard,
  onChanged,
}: {
  imports: ImportBatch[] | null;
  me: string;
  busy: boolean;
  stepUp: StepUp;
  runner: Runner;
  onOpen: (item: ImportBatch, action: "review" | "resume" | "continue") => void;
  onDiscard: (item: ImportBatch) => void;
  onChanged: () => void;
}) {
  const t = useTranslations("Import.history");
  const format = useFormatter();
  const [undoing, setUndoing] = useState<ImportBatch | null>(null);

  return (
    <aside aria-labelledby="import-history-heading" className="flex min-w-0 flex-col gap-4 rounded-lg bg-card p-4 sm:p-6">
      <h2 id="import-history-heading" className="text-lg font-bold tracking-[-0.03em]">
        {t("title")}
      </h2>
      {imports === null ? (
        <p role="alert" className="text-muted-foreground">
          {t("error")}
        </p>
      ) : imports.length === 0 ? (
        <p className="text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {imports.map((item) => {
            const mine = item.uploaded_by === me;
            const who = [item.uploader_first_name, item.uploader_last_name].filter(Boolean).join(" ") || t("someone");
            return (
              <li key={item.id} className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
                <p className="font-bold break-all" title={item.filename}>
                  {middleTruncate(item.filename)}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t("when", { date: format.dateTime(new Date(item.created_at), { dateStyle: "medium", timeStyle: "short" }), who })}
                </p>
                <span className="inline-flex w-fit items-center gap-1.5 rounded-sm bg-muted px-2 py-0.5 text-xs">
                  <span aria-hidden="true" className={cn("size-1.5 rounded-full", tone[item.status])} />
                  {item.status === "rolled_back"
                    ? t("status.rolled_back", { count: item.kept, formatted: format.number(item.kept) })
                    : t(`status.${item.status}`)}
                </span>
                <Counts item={item} />
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {item.status === "staged" && mine ? (
                    <Button variant="link" disabled={busy} onClick={() => onOpen(item, "continue")}>
                      {t("continue")}
                    </Button>
                  ) : null}
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
                    <Button variant="link" disabled={busy} onClick={() => setUndoing(item)}>
                      {item.status === "rolling_back" ? t("resumeUndo") : t("undo")}
                    </Button>
                  ) : null}
                  {item.status === "staged" || item.status === "dry_run" ? (
                    <Button variant="link" disabled={busy} onClick={() => onDiscard(item)}>
                      {t("discard")}
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <UndoDialog
        key={undoing?.id ?? "none"}
        batch={undoing}
        stepUp={stepUp}
        runner={runner}
        onClose={() => setUndoing(null)}
        onChanged={onChanged}
      />
    </aside>
  );
}

function Counts({ item }: { item: ImportBatch }) {
  const t = useTranslations("Import.history");
  const format = useFormatter();
  const c = item.issue_counts;
  const parts: string[] = [];
  if (item.status === "imported" || item.status === "rolled_back" || item.status === "rolling_back" || item.status === "committing") {
    parts.push(t("counts.added", { count: item.imported, formatted: format.number(item.imported) }));
  } else if (item.status === "dry_run") {
    parts.push(t("counts.ready", { count: c.ready ?? 0, formatted: format.number(c.ready ?? 0) }));
  } else {
    parts.push(t("counts.rows", { count: item.row_count, formatted: format.number(item.row_count) }));
  }
  if (item.status !== "staged" && item.status !== "discarded") {
    if (c.duplicate_existing) parts.push(t("counts.existing", { formatted: format.number(c.duplicate_existing) }));
    if (c.duplicate_file) parts.push(t("counts.repeated", { formatted: format.number(c.duplicate_file) }));
    if (item.rejected) parts.push(t("counts.rejected", { formatted: format.number(item.rejected) }));
  }
  return <p className="font-mono text-xs text-muted-foreground">{parts.join(" · ")}</p>;
}

type UndoState =
  | { kind: "loading" }
  | { kind: "confirm"; preview: UndoPreview }
  | { kind: "running"; removed: number; total: number }
  | { kind: "done"; removed: number; kept: number }
  | { kind: "error"; code: ImportErrorCode };

// Undo an import: it removes only the leads nobody has worked on since (a call, note, contact, deal or any change,
// including a new owner); the others stay. The numbers are shown before anything happens.
function UndoDialog({
  batch,
  stepUp,
  runner,
  onClose,
  onChanged,
}: {
  batch: ImportBatch | null;
  stepUp: StepUp;
  runner: Runner;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations("Import.undo");
  const te = useTranslations("Import.errors");
  const format = useFormatter();
  // The dialog is keyed by the import, so each one starts here with its numbers loading.
  const [state, setState] = useState<UndoState>({ kind: "loading" });
  const n = (value: number) => format.number(value);
  const batchId = batch?.id ?? null;

  useEffect(() => {
    if (!batchId) return;
    let current = true;
    attempt(runner, () => previewUndo({ batchId }))
      .then((preview) => current && setState({ kind: "confirm", preview }))
      .catch((cause: unknown) => {
        if (current) setState({ kind: "error", code: cause instanceof ImportStopped && cause.code !== "cancelled" ? cause.code : "unavailable" });
      });
    return () => {
      current = false;
    };
  }, [batchId, runner]);

  const run = async () => {
    if (!batch || state.kind !== "confirm") return;
    const total = state.preview.removable;
    if (!(await stepUp.ensureFresh(180))) return;
    let removed = 0;
    setState({ kind: "running", removed, total });
    try {
      for (;;) {
        const step = await attempt(runner, () => undoImportStep({ batchId: batch.id }));
        removed += step.removed_now;
        setState({ kind: "running", removed, total });
        if (step.status === "rolled_back") {
          setState({ kind: "done", removed, kept: step.kept ?? 0 });
          break;
        }
      }
    } catch (cause) {
      setState({ kind: "error", code: cause instanceof ImportStopped && cause.code !== "cancelled" ? cause.code : "unavailable" });
    } finally {
      onChanged();
    }
  };

  const running = state.kind === "running";
  return (
    <Dialog open={batch !== null} onOpenChange={(open) => (!open && !running ? onClose() : null)}>
      <DialogContent className={cn(phoneSheet, "sm:w-[min(520px,calc(100%-32px))]")}>
        <div className="flex flex-col gap-5 p-6">
          <DialogTitle className="text-xl font-bold tracking-[-0.03em] text-balance">{t("title")}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {state.kind === "confirm" && batch
              ? t("body", {
                  file: batch.filename,
                  date: format.dateTime(new Date(batch.created_at), { dateStyle: "medium" }),
                  removable: state.preview.removable,
                  removableFormatted: n(state.preview.removable),
                  kept: state.preview.kept,
                  keptFormatted: n(state.preview.kept),
                })
              : state.kind === "done"
                ? t("done", { removed: n(state.removed), kept: n(state.kept) })
                : state.kind === "error"
                  ? te(state.code)
                  : t("loading")}
          </DialogDescription>
          {state.kind === "running" ? (
            <div className="flex flex-col gap-2" aria-live="polite">
              <ProgressBar value={state.removed} max={Math.max(state.total, 1)} label={t("title")} />
              <p className="text-sm text-muted-foreground">{t("running", { done: n(state.removed), total: n(state.total) })}</p>
            </div>
          ) : null}
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
              <Button variant="quiet" onClick={onClose}>
                {t("close")}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
