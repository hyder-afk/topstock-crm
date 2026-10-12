"use client";

import { forwardRef, useId } from "react";
import { useTranslations } from "next-intl";
import { FollowUpPicker, OutcomePad, type FollowUp } from "@/components/activity/outcome-pad";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { followUpRule, type CallOutcome } from "@/lib/activities";
import { cn } from "@/lib/utils";

// The queue's outcome rail (Day 4 design 7.4): the shared outcome pad (keys 1 to 7 and 0, 56 px on phones), the note
// (N), Skip (S), this session's counts, and "1 outcome not saved · Retry". Outcomes 5, 6 and 0 open their follow-up
// inline (the default chip highlighted, ↩ confirms, Esc cancels; Book meeting needs a time); 7 asks once more. On a lead
// marked Do not contact meanwhile only 7 and Skip work.
export const QueueRail = forwardRef<HTMLTextAreaElement, {
  choice: CallOutcome | null;
  onPick: (o: CallOutcome) => void;
  follow: FollowUp;
  onFollow: (f: FollowUp) => void;
  onConfirm: () => void;
  onCancel: () => void;
  viewerZone: string;
  leadZoneKey: string;
  now: Date;
  note: string;
  onNote: (v: string) => void;
  onSkip: () => void;
  onOpenNote: () => void;
  onlyDnc: boolean;
  noNumber: boolean;
  stats: { calls: number; talks: number };
  notSaved: number;
  retrying: boolean;
  onRetry: () => void;
  disabled: boolean;
}>(function QueueRail(p, noteRef) {
  const t = useTranslations("Queue");
  const tOut = useTranslations("Outcomes");
  const id = useId();
  const rule = p.choice ? followUpRule("call", p.choice) : "none";
  const expanded = p.choice === "interested" || p.choice === "meeting_booked" || p.choice === "connected" || p.choice === "do_not_contact";
  const needsTime = p.choice === "meeting_booked" && (!p.follow.date || !p.follow.time);
  const disabled: Partial<Record<CallOutcome, boolean>> = {};
  for (const o of ["no_answer", "voicemail", "wrong_number", "not_interested", "interested", "meeting_booked", "connected"] as const) {
    if (p.onlyDnc || p.disabled) disabled[o] = true;
  }
  if (p.noNumber) disabled.wrong_number = true;
  if (p.disabled) disabled.do_not_contact = true;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {p.notSaved > 0 ? (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-status-amber" />
          <span className="flex-1 font-bold">{t("notSaved", { count: p.notSaved })}</span>
          <Button variant="neutral" className="min-h-11 px-3 text-sm sm:min-h-9" aria-disabled={p.retrying || undefined} onClick={() => !p.retrying && p.onRetry()}>
            {p.retrying ? t("retrying") : t("retry")}
          </Button>
        </div>
      ) : null}

      <section aria-labelledby={`${id}-pad`} className="flex flex-col gap-3">
        <h2 id={`${id}-pad`} className="text-sm font-bold text-muted-foreground">
          {t("padTitle")}
        </h2>
        <OutcomePad value={p.choice} onChange={p.onPick} disabled={disabled} className="max-lg:grid-cols-2 lg:grid-cols-1" />
        {expanded ? (
          <div className="flex flex-col gap-3 rounded-md border border-border p-3">
            {p.choice === "do_not_contact" ? (
              <p className="text-sm">{tOut("confirmDnc")}</p>
            ) : (
              <FollowUpPicker
                rule={rule}
                value={p.follow}
                onChange={p.onFollow}
                viewerZone={p.viewerZone}
                leadZoneKey={p.leadZoneKey}
                now={p.now}
                legend={rule === "time" ? tOut("meetingWhen") : undefined}
              />
            )}
            {needsTime ? <p className="text-sm text-status-red">{t("needTime")}</p> : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="neutral" onClick={p.onConfirm} aria-disabled={needsTime || undefined} aria-keyshortcuts="Enter">
                {p.choice === "do_not_contact" ? tOut("confirmDncAction") : t("confirm")}
              </Button>
              <Button variant="quiet" onClick={p.onCancel} aria-keyshortcuts="Escape">
                {t("cancel")}
              </Button>
              <span className="hidden text-xs text-muted-foreground lg:inline">{t("confirmKeys")}</span>
            </div>
          </div>
        ) : null}
      </section>

      <label className="hidden flex-col gap-1.5 lg:flex">
        <span className="flex items-center justify-between text-sm font-bold">
          {t("note")}
          <Kbd aria-hidden="true">N</Kbd>
        </span>
        <textarea
          ref={noteRef}
          name="queue_note"
          value={p.note}
          onChange={(e) => p.onNote(e.target.value)}
          placeholder={t("notePlaceholder")}
          dir="auto"
          rows={3}
          maxLength={10000}
          aria-keyshortcuts="n"
          className="min-h-20 resize-y rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
        />
      </label>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="quiet" onClick={p.onOpenNote} className="lg:hidden">
          {t("note")}
          {p.note.trim() ? <span aria-hidden="true" className="size-1.5 rounded-full bg-foreground" /> : null}
        </Button>
        <Button variant="quiet" onClick={p.onSkip} aria-keyshortcuts="s" disabled={p.disabled} className={cn("max-lg:bg-transparent max-lg:px-0 max-lg:underline max-lg:underline-offset-4")}>
          {t("skip")}
          <Kbd aria-hidden="true" className="hidden lg:inline-grid">
            S
          </Kbd>
        </Button>
        <p className="font-mono text-xs text-muted-foreground">{t("stats", { calls: p.stats.calls, talks: p.stats.talks })}</p>
      </div>
      <p className="hidden text-xs text-muted-foreground lg:block">{t("keysHint")}</p>
    </div>
  );
});
