"use client";

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { AnimatePresence, motion, useReducedMotion, type PanInfo } from "motion/react";
import { PhoneOff, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { FollowUpPicker, OutcomePad, followUpArgs, followUpReady, noFollowUp, type FollowUp } from "@/components/activity/outcome-pad";
import { lastUndoable, useLogActivity, useUndoActivity } from "@/components/activity/use-activities";
import { followUpRule, outcomeForKey, type CallOutcome } from "@/lib/activities";
import { project, springs } from "@/lib/motion";
import { isTyping } from "@/lib/shortcuts";
import { browserZone, nextWorkingDate } from "@/lib/timezones";
import { useModKey } from "@/lib/use-platform";
import { cn } from "@/lib/utils";

// The call panel (Day 4 design 7.3, prototype behaviour): mounted once in the app layout, so a call started on the lead
// page or the leads preview survives moving around the app. A floating glass panel above the dock (a bottom sheet on
// phones) with the number and a timer (shown only; never stored: design section 12), End call, then the outcome pad,
// a note and Save to timeline (Cmd/Ctrl+Enter). Closing with nothing chosen says "Call not logged · Log it". After the
// phone app took over (page hidden), coming back after 5 s or more asks "How did it go?" ("Away about 3 min": time
// away, not the call's length). Digits 1 to 7 and 0 pick an outcome by key position (AZERTY-safe); U or Cmd/Ctrl+Z
// undoes the last logged entry within 2 minutes when nobody is typing.
export type CallTarget = {
  leadId: string;
  leadName: string;
  ownerName: string | null;
  callZoneKey: string;
  number: string;
  dialled: "lead" | "contact";
  contactId: string | null;
  contactName: string | null;
};

type Phase = "calling" | "outcome" | "notLogged";
type CallState = {
  target: CallTarget;
  startedAt: number;
  phase: Phase;
  awayMs: number | null;
  origin: { x: number; y: number } | null;
  // The Call button that opened the panel: focus goes back to it when the panel closes (WCAG 2.4.3).
  opener: HTMLElement | null;
};
type CallPanelApi = { startCall: (target: CallTarget, from?: HTMLElement | null) => void; activeLeadId: string | null };

const CallPanelContext = createContext<CallPanelApi>({ startCall: () => {}, activeLeadId: null });
export const useCallPanel = () => useContext(CallPanelContext);

// True when the keyboard focus is inside `el` or was lost to the page (its focused element unmounted), so moving it is ours
// to do; false when the person has already moved on to something else.
function focusWithin(el: HTMLElement | null) {
  const active = document.activeElement;
  return !active || active === document.body || !!el?.contains(active);
}

// Focus the opener again if it is still on screen; otherwise the page's <main> (made focusable for this only).
function focusBack(opener: HTMLElement | null) {
  if (opener?.isConnected && opener.getClientRects().length > 0) {
    opener.focus();
    if (document.activeElement === opener) return;
  }
  const main = document.getElementById("main");
  if (!main) return;
  if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
  main.focus({ preventScroll: true });
}

export function CallPanelProvider({ children }: { children: React.ReactNode }) {
  const [call, setCall] = useState<CallState | null>(null);
  const undo = useUndoActivity();

  const startCall = useCallback((target: CallTarget, from?: HTMLElement | null) => {
    const rect = from?.getBoundingClientRect();
    setCall({
      target,
      startedAt: Date.now(),
      phase: "calling",
      awayMs: null,
      origin: rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null,
      opener: from ?? null,
    });
  }, []);

  // U or Cmd/Ctrl+Z: undo the last entry this tab logged, within 2 minutes, when nobody is typing and no dialog is open.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || isTyping(event.target)) return;
      if (document.querySelector("[role=dialog]")) return;
      const isUndo =
        (event.key.toLowerCase() === "z" && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) ||
        (event.key.toLowerCase() === "u" && !event.metaKey && !event.ctrlKey && !event.altKey);
      if (!isUndo) return;
      const last = lastUndoable();
      if (!last) return;
      event.preventDefault();
      void undo(last.activityId, last.leadId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo]);

  // Closing (Save, Don't log, second close): focus goes back to the Call button before the panel unmounts, because the
  // exit animation keeps the focused element alive until it leaves and the focus would then drop to <body>.
  const close = useCallback(
    (restoreFocus: boolean) => {
      if (restoreFocus) focusBack(call?.opener ?? null);
      setCall(null);
    },
    [call?.opener],
  );

  const api = useMemo(() => ({ startCall, activeLeadId: call?.target.leadId ?? null }), [startCall, call?.target.leadId]);
  return (
    <CallPanelContext.Provider value={api}>
      {children}
      <AnimatePresence>
        {call ? <CallPanel key={call.startedAt} call={call} onChange={setCall} onClose={close} /> : null}
      </AnimatePresence>
    </CallPanelContext.Provider>
  );
}

function useClock(startedAt: number, running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function CallPanel({ call, onChange, onClose }: { call: CallState; onChange: (c: CallState) => void; onClose: (restoreFocus: boolean) => void }) {
  const t = useTranslations("CallPanel");
  const tOut = useTranslations("Outcomes");
  const reduce = useReducedMotion();
  const mod = useModKey() ?? "Ctrl";
  const log = useLogActivity();
  const headingId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const padRef = useRef<HTMLDivElement>(null);
  const logItRef = useRef<HTMLButtonElement>(null);
  const hiddenAt = useRef<number | null>(null);
  const [outcome, setOutcome] = useState<CallOutcome | null>(null);
  const [note, setNote] = useState("");
  const [follow, setFollow] = useState<FollowUp>(noFollowUp);
  const [saving, setSaving] = useState(false);
  const [now] = useState(() => new Date());
  const { target, phase } = call;
  const clock = useClock(call.startedAt, phase === "calling");
  const viewerZone = browserZone() ?? "Europe/Paris";
  const rule = outcome ? followUpRule("call", outcome) : "none";
  const ready = !!outcome && followUpReady(rule, follow) && !saving;

  // Picking an outcome sets its follow-up default: Interested → the next working day on the lead's side.
  const pick = useCallback(
    (o: CallOutcome) => {
      setOutcome(o);
      const r = followUpRule("call", o);
      if (r === "date_or_time") setFollow({ date: nextWorkingDate(new Date(), target.callZoneKey), time: null });
      else if (r === "time") setFollow({ date: nextWorkingDate(new Date(), target.callZoneKey), time: "10:00" });
      else setFollow(noFollowUp);
    },
    [target.callZoneKey],
  );

  // Ends the panel. Focus returns to the opener only if it was in the panel (or lost), not if the person has moved on.
  const finish = useCallback(() => onClose(focusWithin(panelRef.current)), [onClose]);

  const endCall = useCallback(() => {
    onChange({ ...call, phase: "outcome" });
  }, [call, onChange]);

  // Closing before Save never loses a call silently: first "Call not logged · Log it" (a chosen outcome and the note are
  // kept for Log it), then a second close (or Don't log) ends the panel.
  const dismiss = useCallback(() => {
    if (phase === "notLogged") finish();
    else onChange({ ...call, phase: "notLogged" });
  }, [phase, finish, onChange, call]);

  const save = useCallback(async () => {
    if (!outcome || !ready) return;
    setSaving(true);
    const res = await log({
      input: {
        leadId: target.leadId,
        type: "call",
        outcome,
        body: note,
        contactId: target.contactId,
        dialled: target.dialled,
        ...followUpArgs(follow, viewerZone),
        leadName: target.leadName,
      },
      preview: { contact_name: target.contactName },
      ownerName: target.ownerName,
    });
    setSaving(false);
    if (res.ok) finish();
  }, [outcome, ready, log, target, note, follow, viewerZone, finish]);

  // End call moves the focus to the pad (design 7.3).
  useEffect(() => {
    if (phase === "outcome") padRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    // "Call not logged" replaces the form (and the focused pad key with it): put the focus on Log it.
    if (phase === "notLogged" && focusWithin(panelRef.current)) logItRef.current?.focus();
  }, [phase]);

  // The phone app takes over after tel: (page hidden). Back after 5 s or more: "How did it go?".
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt.current = Date.now();
      } else if (hiddenAt.current !== null) {
        const away = Date.now() - hiddenAt.current;
        hiddenAt.current = null;
        if (away >= 5000 && call.phase === "calling") onChange({ ...call, phase: "outcome", awayMs: away });
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [call, onChange]);

  // Keys while the panel is open: digits pick an outcome (by position), Esc closes, Cmd/Ctrl+Enter saves.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (document.querySelector("[role=dialog]")) return;
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && phase === "outcome") {
        event.preventDefault();
        void save();
        return;
      }
      if (event.key === "Escape" && !isTyping(event.target)) {
        event.preventDefault();
        dismiss();
        return;
      }
      if (isTyping(event.target)) return;
      const o = outcomeForKey(event);
      if (!o) return;
      event.preventDefault();
      if (phase !== "outcome") onChange({ ...call, phase: "outcome" });
      pick(o);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [phase, save, dismiss, pick, onChange, call]);

  // Grow from the Call button: the transform origin is that button's centre, relative to where the panel sits.
  const [origin, setOrigin] = useState("50% 100%");
  useEffect(() => {
    const el = panelRef.current;
    if (!el || !call.origin) return;
    const r = el.getBoundingClientRect();
    setOrigin(`${call.origin.x - r.left}px ${call.origin.y - r.top}px`);
  }, [call.origin]);

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.y + (reduce ? 0 : project(info.velocity.y)) > 140) dismiss();
  };

  const awayMinutes = call.awayMs ? Math.max(1, Math.round(call.awayMs / 60_000)) : null;
  const who = target.contactName ? `${target.leadName} · ${target.contactName}` : target.leadName;

  return (
    <motion.section
      ref={panelRef}
      role="region"
      aria-labelledby={headingId}
      initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
      transition={reduce ? { duration: 0.12 } : springs.sheet}
      style={{ transformOrigin: origin }}
      className={cn(
        "dock-glass fixed z-40 flex max-h-[calc(100dvh-24px)] flex-col overflow-y-auto overscroll-contain border border-border text-foreground shadow-[0_16px_48px_rgb(14_14_16/0.22)]",
        "inset-x-0 bottom-0 rounded-t-[24px] pb-[calc(16px+env(safe-area-inset-bottom,0px))]",
        "sm:inset-x-auto sm:right-6 sm:bottom-[104px] sm:w-[320px] sm:rounded-[24px] sm:pb-4",
      )}
    >
      {/* The header is the drag handle: pull down to close (rubber band, velocity projected). */}
      <motion.div
        drag="y"
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0.08, bottom: 0.6 }}
        dragSnapToOrigin
        onDragEnd={onDragEnd}
        style={{ touchAction: "none" }}
        className="flex cursor-grab items-start gap-2 px-5 pt-3 select-none active:cursor-grabbing"
      >
        <span aria-hidden="true" className="absolute top-1.5 left-1/2 h-1 w-9 -translate-x-1/2 rounded-full bg-border sm:hidden" />
        <div className="min-w-0 flex-1 pt-2">
          <h2 id={headingId} className="text-sm font-bold text-balance break-words">
            {phase === "outcome" && call.awayMs ? t("howDidItGo") : t("calling", { who })}
          </h2>
          {phase === "outcome" && awayMinutes ? (
            <p className="text-xs text-muted-foreground">{t("away", { minutes: awayMinutes })}</p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t("close")}
          className="-mr-2 grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground transition-[color,transform] duration-150 hover:text-foreground active:scale-[0.97]"
        >
          <X aria-hidden="true" strokeWidth={1.75} className="size-5" />
        </button>
      </motion.div>

      <div className="flex flex-col gap-3 px-5 pt-1">
        <div className="flex items-baseline justify-between gap-3">
          <span role="timer" className="font-mono text-3xl tabular-nums" aria-label={t("timer")}>
            {clock}
          </span>
          <span className="truncate font-mono text-sm text-muted-foreground" translate="no">
            {target.number}
          </span>
        </div>

        {phase === "calling" ? (
          <Button variant="neutral" width="full" onClick={endCall}>
            <PhoneOff aria-hidden="true" strokeWidth={2} className="size-4" />
            {t("end")}
          </Button>
        ) : null}

        {phase === "notLogged" ? (
          <div role="status" className="flex flex-col gap-3">
            <p className="text-sm">{t("dismissed")}</p>
            <div className="flex gap-2">
              <Button ref={logItRef} variant="neutral" onClick={() => onChange({ ...call, phase: "outcome" })}>
                {t("logIt")}
              </Button>
              <Button variant="quiet" onClick={finish}>
                {t("discard")}
              </Button>
            </div>
          </div>
        ) : null}

        {phase === "outcome" ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div ref={padRef}>
              <OutcomePad value={outcome} onChange={pick} disabled={{ wrong_number: !target.number }} />
            </div>
            {outcome === "do_not_contact" ? <p className="text-sm text-muted-foreground">{tOut("confirmDnc")}</p> : null}
            {outcome ? (
              <FollowUpPicker
                rule={rule}
                value={follow}
                onChange={setFollow}
                viewerZone={viewerZone}
                leadZoneKey={target.callZoneKey}
                now={now}
                legend={rule === "time" ? tOut("meetingWhen") : undefined}
              />
            ) : null}
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-bold">{t("note")}</span>
              <Textarea name="note" autoComplete="off" value={note} onChange={(e) => setNote(e.target.value)} maxRows={6} className="min-h-16 text-sm" dir="auto" />
            </label>
            <Button type="submit" variant="neutral" width="full" aria-disabled={!ready || undefined} disabled={!outcome}>
              {saving ? t("saving") : outcome === "do_not_contact" ? tOut("confirmDncAction") : t("save")}
              <span className="ml-1 hidden gap-1 sm:inline-flex" aria-hidden="true">
                <Kbd className="border-transparent bg-primary-foreground/15 text-primary-foreground">{mod}</Kbd>
                <Kbd className="border-transparent bg-primary-foreground/15 text-primary-foreground">↩</Kbd>
              </span>
            </Button>
          </form>
        ) : null}
      </div>
    </motion.section>
  );
}
