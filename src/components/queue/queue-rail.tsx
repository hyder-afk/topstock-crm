"use client";

import { forwardRef, useEffect, useId, useRef } from "react";
import { useTranslations } from "next-intl";
import { OpenDealSwitch } from "@/components/activity/open-deal-switch";
import { FollowUpPicker, OutcomePad, type FollowUp } from "@/components/activity/outcome-pad";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { followUpRule, type CallOutcome } from "@/lib/activities";
import { cn } from "@/lib/utils";

// The queue's outcome rail (Day 4 design 7.4; Day 5b adds "Open a deal" to Interested and Book meeting): the shared outcome pad (keys 1 to 7 and 0, 56 px on phones), the note
// (N), Skip (S) and this session's counts ("1 outcome not saved · Retry" is in the page header, in every phase). Outcomes 5, 6 and 0 open their follow-up
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
  disabled: boolean;
  /** Day 5b: the "Open a deal" switch for Interested and Book meeting; null for people who may not change the lead. */
  deal: React.ComponentProps<typeof OpenDealSwitch> | null;
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

  // The follow-up (5, 6, 0) and the Do not contact question open under the pad, which can be below the fold (on a phone,
  // and on a laptop screen 900 px tall, more so in French): they are scrolled into view, clear of the dock, so Confirm
  // is in reach. Below 1024 they also take the focus, so the tap visibly opens them; at desktop width the focus stays
  // where it was (the keys go on working: Enter confirms, Escape cancels).
  const panelRef = useRef<HTMLDivElement>(null);
  const choice = p.choice;
  useEffect(() => {
    const panel = panelRef.current;
    if (!choice || !panel) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!window.matchMedia("(min-width: 1024px)").matches) panel.focus({ preventScroll: true });
    panel.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [choice]);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section aria-labelledby={`${id}-pad`} className="flex flex-col gap-3">
        <h2 id={`${id}-pad`} className="text-sm font-bold text-muted-foreground">
          {t("padTitle")}
        </h2>
        <OutcomePad value={p.choice} onChange={p.onPick} disabled={disabled} className="max-lg:grid-cols-2 lg:grid-cols-1" />
        {expanded ? (
          <div
            ref={panelRef}
            data-queue-panel
            tabIndex={-1}
            role="group"
            aria-label={tOut(p.choice ?? "connected")}
            className="flex scroll-mt-4 scroll-mb-[calc(112px+env(safe-area-inset-bottom,0px))] flex-col gap-3 rounded-md border border-border p-3 focus-visible:outline-offset-2"
          >
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
            {(p.choice === "interested" || p.choice === "meeting_booked") && p.deal ? <OpenDealSwitch {...p.deal} /> : null}
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
          autoComplete="off"
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
