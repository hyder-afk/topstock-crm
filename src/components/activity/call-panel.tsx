"use client";

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { AnimatePresence, motion, useIsPresent, useReducedMotion, type PanInfo } from "motion/react";
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
// undoes the last logged entry within 2 minutes when nobody is typing. A second Call while the outcome step is open waits
// behind the open call (nothing is dropped); closing puts the focus back on the Call button that opened the panel.
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

// Focus the opener again if it is still rendered; otherwise the page's <main> (made focusable for this only, without the
// focus ring: a ring around the whole page says nothing). An opener scrolled out of view gets the focus without pulling
// the page back up to it.
function focusBack(opener: HTMLElement | null) {
  if (opener?.isConnected && opener.getClientRects().length > 0) {
    const r = opener.getBoundingClientRect();
    opener.focus({ preventScroll: r.bottom <= 0 || r.top >= window.innerHeight });
    if (document.activeElement === opener) return;
  }
  const main = document.getElementById("main");
  if (!main) return;
  if (!main.hasAttribute("tabindex")) {
    main.setAttribute("tabindex", "-1");
    main.style.outline = "none";
  }
  main.focus({ preventScroll: true });
}

const whoOf = (target: CallTarget) => (target.contactName ? `${target.leadName} · ${target.contactName}` : target.leadName);

// `call` is the open panel; `next` is a call started while `call` still had its outcome step open; `nudge` counts those
// presses so the open panel can pull the focus to itself.
type Slot = { call: CallState | null; next: CallState | null; nudge: number };

export function CallPanelProvider({ children }: { children: React.ReactNode }) {
  const [slot, setSlot] = useState<Slot>({ call: null, next: null, nudge: 0 });
  const { call, next, nudge } = slot;
  // The latest committed slot, for `close`: a Save that awaited the server must see a call queued during that wait.
  const slotRef = useRef(slot);
  useEffect(() => {
    slotRef.current = slot;
  }, [slot]);
  const undo = useUndoActivity();

  // A second Call never drops an open call silently (design 7.3): once End call was pressed (or "Call not logged" is
  // showing), the open call keeps its outcome and note, and the new call waits behind it and opens when it is saved or
  // not logged. While the first is still "Calling", nothing has been chosen yet and the new call replaces it.
  const startCall = useCallback((target: CallTarget, from?: HTMLElement | null) => {
    const rect = from?.getBoundingClientRect();
    const fresh: CallState = {
      target,
      startedAt: Date.now(),
      phase: "calling",
      awayMs: null,
      origin: rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null,
      opener: from ?? null,
    };
    setSlot((s) => (s.call && s.call.phase !== "calling" ? { ...s, next: fresh, nudge: s.nudge + 1 } : { ...s, call: fresh, next: null }));
  }, []);

  // Only the open call may change the slot: a panel still playing its exit animation must not bring itself back.
  const change = useCallback((c: CallState) => setSlot((s) => (s.call?.startedAt === c.startedAt ? { ...s, call: c } : s)), []);

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
  // A waiting call opens next; the focus then goes to the Call button that started it.
  const close = useCallback((startedAt: number, restoreFocus: boolean) => {
    const cur = slotRef.current;
    if (cur.call?.startedAt !== startedAt) return;
    if (restoreFocus) focusBack(cur.next ? cur.next.opener : cur.call.opener);
    setSlot((s) => (s.call?.startedAt === startedAt ? { ...s, call: s.next, next: null } : s));
  }, []);

  const api = useMemo(() => ({ startCall, activeLeadId: call?.target.leadId ?? null }), [startCall, call?.target.leadId]);
  return (
    <CallPanelContext.Provider value={api}>
      {children}
      <AnimatePresence>
        {call ? (
          <CallPanel key={call.startedAt} call={call} onChange={change} onClose={close} queuedWho={next ? whoOf(next.target) : null} nudge={nudge} />
        ) : null}
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

function CallPanel({
  call,
  onChange,
  onClose,
  queuedWho,
  nudge,
}: {
  call: CallState;
  onChange: (c: CallState) => void;
  onClose: (startedAt: number, restoreFocus: boolean) => void;
  queuedWho: string | null;
  nudge: number;
}) {
  const t = useTranslations("CallPanel");
  const tOut = useTranslations("Outcomes");
  const reduce = useReducedMotion();
  // False while the panel plays its exit animation (after Save or a close): it then takes no more keys or actions, so an
  // Esc or Cmd/Ctrl+Enter in that half second cannot log the call twice or touch the call that opened next.
  const isPresent = useIsPresent();
  const mod = useModKey() ?? "Ctrl";
  const log = useLogActivity();
  const headingId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const padRef = useRef<HTMLDivElement>(null);
  const logItRef = useRef<HTMLButtonElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const seenNudge = useRef(nudge);
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
  const finish = useCallback(() => {
    if (isPresent) onClose(call.startedAt, focusWithin(panelRef.current));
  }, [isPresent, onClose, call.startedAt]);

  const endCall = useCallback(() => {
    onChange({ ...call, phase: "outcome" });
  }, [call, onChange]);

  // Closing before Save never loses a call silently: first "Call not logged · Log it" (a chosen outcome and the note are
  // kept for Log it), then a second close (or Don't log) ends the panel.
  const dismiss = useCallback(() => {
    if (!isPresent) return;
    if (phase === "notLogged") finish();
    else onChange({ ...call, phase: "notLogged" });
  }, [isPresent, phase, finish, onChange, call]);

  const save = useCallback(async () => {
    if (!outcome || !ready || !isPresent) return;
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
  }, [outcome, ready, isPresent, log, target, note, follow, viewerZone, finish]);

  // End call moves the focus to the pad (design 7.3).
  useEffect(() => {
    if (phase === "outcome") padRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    // "Call not logged" replaces the form (and the focused pad key with it): put the focus on Log it.
    if (phase === "notLogged" && focusWithin(panelRef.current)) logItRef.current?.focus();
  }, [phase]);

  // Call was pressed again while this call waits for its outcome: bring the focus here, to what finishes it (Log it,
  // Save, or the pad when nothing is picked yet). The waiting call is named above the timer.
  useEffect(() => {
    if (nudge === seenNudge.current) return;
    seenNudge.current = nudge;
    const firstKey = padRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)") ?? null;
    const el = phase === "notLogged" ? logItRef.current : outcome ? saveRef.current : firstKey;
    el?.focus();
  }, [nudge, phase, outcome]);

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
    if (!isPresent) return;
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
  }, [isPresent, phase, save, dismiss, pick, onChange, call]);

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
  const who = whoOf(target);

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
        {/* Stays in the accessibility tree while empty (sr-only, not display:none) so the queued-call message is announced. */}
        <p role="status" className={cn("text-sm font-bold text-pretty", !queuedWho && "sr-only")}>
          {queuedWho ? t("queued", { who: queuedWho }) : null}
        </p>
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
            <Button ref={saveRef} type="submit" variant="neutral" width="full" aria-disabled={!ready || undefined} disabled={!outcome}>
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
