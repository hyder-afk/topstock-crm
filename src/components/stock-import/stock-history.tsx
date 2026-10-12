"use client";

import { useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, phoneSheet } from "@/components/ui/dialog";
import { ProgressBar } from "@/components/import/progress";
import type { StockImportBatch, StockUndoPreview } from "@/lib/stock-import";
import { cn } from "@/lib/utils";

// Past stock imports (newest first): who, when, what it did, and the next step for each (Undo, Continue, Discard).
export function StockHistory({
  imports,
  failed,
  busy,
  headingRef,
  onRetry,
  onUndo,
  onResume,
  onDiscard,
}: {
  imports: StockImportBatch[] | null;
  failed: boolean;
  busy: boolean;
  headingRef: React.Ref<HTMLHeadingElement>;
  onRetry: () => void;
  onUndo: (item: StockImportBatch) => void;
  onResume: (item: StockImportBatch) => void;
  onDiscard: (item: StockImportBatch) => void;
}) {
  const t = useTranslations("StockImport.history");
  const format = useFormatter();
  // Discarded checks changed nothing: they are left out of the list.
  const shown = imports?.filter((i) => i.status !== "discarded") ?? null;
  return (
    <section aria-labelledby="stock-history-heading" className="flex flex-col gap-3">
      <h2 ref={headingRef} id="stock-history-heading" tabIndex={-1} className="text-lg font-bold tracking-[-0.03em] focus:outline-none">
        {t("title")}
      </h2>
      {failed ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-md bg-muted px-4 py-3">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-status-red" />
          <p className="text-sm">{t("error")}</p>
          <Button variant="quiet" className="bg-background" onClick={onRetry}>
            {t("retry")}
          </Button>
        </div>
      ) : shown === null ? (
        <ul aria-label={t("loading")} className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <li key={i} className="h-20 rounded-md bg-muted motion-safe:animate-pulse" />
          ))}
        </ul>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {shown.map((item) => {
            const who = [item.uploader_first_name, item.uploader_last_name].filter(Boolean).join(" ") || t("someone");
            const when = format.dateTime(new Date(item.imported_at ?? item.checked_at ?? item.created_at), { dateStyle: "medium", timeStyle: "short" });
            return (
              <li key={item.id} className="flex flex-col gap-2 p-4">
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate font-bold" title={item.filename} translate="no">
                      {item.filename}
                    </span>
                    <span className="text-xs text-muted-foreground">{t("when", { who, when })}</span>
                  </div>
                  <span className="inline-flex shrink-0 items-center gap-1.5 rounded-sm bg-muted px-2 py-0.5 text-xs">
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-1.5 rounded-full",
                        item.status === "imported" ? "bg-status-green" : item.status === "committing" || item.status === "rolling_back" ? "bg-status-amber" : "bg-muted-foreground",
                      )}
                    />
                    {t(`status.${item.status}`)}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">
                  {item.status === "rolled_back"
                    ? t("undoneCounts", { kept: item.kept, keptFormatted: format.number(item.kept), by: item.undone_by_first_name ?? t("someone") })
                    : t("counts", {
                        products: item.imported,
                        productsFormatted: format.number(item.imported),
                        rejected: item.rejected,
                        rejectedFormatted: format.number(item.rejected),
                      })}
                </p>
                <div className="flex flex-wrap gap-2">
                  {item.status === "imported" ? (
                    <Button variant="quiet" disabled={busy} onClick={() => onUndo(item)}>
                      {t("undo")}
                    </Button>
                  ) : null}
                  {item.status === "rolling_back" ? (
                    <Button variant="quiet" disabled={busy} onClick={() => onUndo(item)}>
                      {t("resumeUndo")}
                    </Button>
                  ) : null}
                  {item.status === "committing" ? (
                    <Button variant="quiet" disabled={busy} onClick={() => onResume(item)}>
                      {t("resume")}
                    </Button>
                  ) : null}
                  {item.status === "staged" || item.status === "dry_run" ? (
                    <Button variant="quiet" disabled={busy} onClick={() => onDiscard(item)}>
                      {t("discard")}
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export type UndoState =
  | { kind: "closed" }
  | { kind: "preview"; item: StockImportBatch; preview: StockUndoPreview | null; error: boolean }
  | { kind: "running"; item: StockImportBatch; done: number; total: number }
  | { kind: "done"; item: StockImportBatch; kept: number }
  | { kind: "paused"; item: StockImportBatch; code: string };

// Undo asks first with what would happen (design 7.8: reversed or kept quantities, archived or kept new products,
// restored or kept prices), then runs in chunks with a progress bar; it can pause and resume from Past imports.
export function StockUndoDialog({
  state,
  onClose,
  onRun,
  onCloseFocus,
}: {
  state: UndoState;
  onClose: () => void;
  onRun: () => void;
  onCloseFocus: () => void;
}) {
  const t = useTranslations("StockImport.undo");
  const te = useTranslations("StockImport.errors");
  const format = useFormatter();
  const n = (v: number) => format.number(v);
  const [lastOpen, setLastOpen] = useState<UndoState>(state);
  if (state.kind !== "closed" && state !== lastOpen) setLastOpen(state);
  const s = state.kind === "closed" ? lastOpen : state;
  const running = s.kind === "running";
  return (
    <Dialog open={state.kind !== "closed"} onOpenChange={(next) => (next || running ? null : onClose())}>
      <DialogContent
        className={cn(phoneSheet, "sm:w-[min(520px,calc(100%-32px))]")}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onCloseFocus();
        }}
        onEscapeKeyDown={(event) => running && event.preventDefault()}
      >
        <div className="flex flex-col gap-5 p-6">
          <div className="flex flex-col gap-2">
            <DialogTitle className="text-xl font-bold tracking-[-0.03em] text-balance">
              {s.kind === "running" ? t("runningTitle") : s.kind === "done" ? t("doneTitle") : s.kind === "paused" ? t("pausedTitle") : t("title")}
            </DialogTitle>
            <DialogDescription asChild>
              <div className="flex flex-col gap-2 text-muted-foreground">
                {s.kind === "preview" ? (
                  s.error ? (
                    <p role="alert">{t("previewFailed")}</p>
                  ) : s.preview === null ? (
                    <p aria-busy="true">{t("loading")}</p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      <li>{t("qty", { reverse: s.preview.qty_reverse, reverseFormatted: n(s.preview.qty_reverse), kept: s.preview.qty_kept, keptFormatted: n(s.preview.qty_kept) })}</li>
                      <li>{t("archive", { archive: s.preview.archive, archiveFormatted: n(s.preview.archive), kept: s.preview.archive_kept, keptFormatted: n(s.preview.archive_kept) })}</li>
                      <li>{t("fields", { restore: s.preview.fields_restore, restoreFormatted: n(s.preview.fields_restore), kept: s.preview.fields_kept, keptFormatted: n(s.preview.fields_kept) })}</li>
                    </ul>
                  )
                ) : s.kind === "running" ? (
                  <>
                    <p>{t("runningBody")}</p>
                    <ProgressBar value={s.done} max={Math.max(1, s.total)} label={t("running", { done: n(s.done), total: n(s.total) })} />
                    <p className="font-mono text-sm tabular-nums" aria-live="polite">
                      {t("running", { done: n(s.done), total: n(s.total) })}
                    </p>
                  </>
                ) : s.kind === "done" ? (
                  <p>{t("done", { kept: s.kept, keptFormatted: n(s.kept) })}</p>
                ) : s.kind === "paused" ? (
                  <p role="alert">{te(s.code as "unavailable")}</p>
                ) : null}
              </div>
            </DialogDescription>
          </div>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            {s.kind === "preview" ? (
              <>
                <Button variant="quiet" onClick={onClose}>
                  {t("keep")}
                </Button>
                <Button variant="neutral" onClick={onRun} disabled={s.preview === null || s.error}>
                  {t("run")}
                </Button>
              </>
            ) : s.kind === "running" ? null : (
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
