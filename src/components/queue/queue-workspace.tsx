"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import { ArrowLeft } from "lucide-react";
import { followUpArgs, noFollowUp, type FollowUp } from "@/components/activity/outcome-pad";
import { useClientNow } from "@/components/lead/local-time";
import { QueueCardView, defaultDial, dialNumber, type Dialled } from "@/components/queue/queue-card";
import { QueueRail } from "@/components/queue/queue-rail";
import { useQueue, type QueueEvent } from "@/components/queue/use-queue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, phoneSheet } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { useToast } from "@/components/ui/toast";
import { followUpRule, type CallOutcome } from "@/lib/activities";
import { countryName } from "@/lib/countries";
import type { LeadStatus } from "@/lib/leads";
import { springs } from "@/lib/motion";
import { parseMoney } from "@/lib/money";
import { callHref } from "@/lib/phone";
import { emptyReason, firstOpening, queueKeyFor, readSkipLunch, writeSkipLunch, type QueueScope, type QueueSummary } from "@/lib/queue";
import { isTyping } from "@/lib/shortcuts";
import { browserZone, localDate, nextWorkingDate, spanEnds, zoneCity } from "@/lib/timezones";
import { cn } from "@/lib/utils";

const noop = () => () => {};
const TALKS: CallOutcome[] = ["connected", "interested", "meeting_booked", "not_interested"];
const statsKey = (day: string) => `topstock.queue.stats.${day}`;

function readStats(day: string): { calls: number; talks: number } {
  try {
    const v = JSON.parse(window.sessionStorage.getItem(statsKey(day)) ?? "null") as { calls?: unknown; talks?: unknown } | null;
    return { calls: Number(v?.calls) || 0, talks: Number(v?.talks) || 0 };
  } catch {
    return { calls: 0, talks: 0 };
  }
}

async function fetchSummary(scope: QueueScope, skipLunch: boolean): Promise<QueueSummary> {
  const res = await fetch(`/api/queue/summary?scope=${scope}&skip_lunch=${skipLunch ? "1" : "0"}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as QueueSummary;
}

/** A calling zone's place, for "Leads in London open at 09:00": a span key is its country, a zone its city. */
function placeOf(key: string, locale: string) {
  return spanEnds(key) ? (countryName(key, locale) ?? key) : zoneCity(key);
}

// The work queue (Day 4 design 5.4 and 7.4). The server page only reads the counts: claims start on an explicit
// Start (↩). Working: the card (about 2/3) and the outcome rail (360 px) at 1440; the card full width with a big red
// Call, then a 2 × 4 pad of 56 px keys, below 1024. One key logs the outcome, the reserve card shows at once (out to
// the left, in from the right, the `snappy` spring; reduced motion: a short fade), focus goes to its heading, and one
// polite message says what was logged and who is next.
export function QueueWorkspace({
  initialSummary,
  canWide,
  mineCount,
  me,
  zone,
}: {
  initialSummary: QueueSummary | null;
  canWide: boolean;
  mineCount: number;
  me: string | null;
  zone: string;
}) {
  const t = useTranslations("Queue");
  const tOut = useTranslations("Outcomes");
  const tErr = useTranslations("Errors");
  const tStatus = useTranslations("Leads.status");
  const tStage = useTranslations("Stages");
  const format = useFormatter();
  const locale = useLocale();
  const toast = useToast();
  const reduce = useReducedMotion();
  const now = useClientNow(30_000);
  const viewerZone = useSyncExternalStore(noop, () => browserZone() ?? "Europe/Paris", () => "Europe/Paris");
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Where the focus goes when what held it leaves (keyboard first: never the page): the page title while cards load,
  // the Start button back on the start screen, the empty state's heading.
  const titleRef = useRef<HTMLHeadingElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const emptyRef = useRef<HTMLHeadingElement>(null);
  const focusStart = useRef(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [live, setLive] = useState("");
  const [choice, setChoice] = useState<CallOutcome | null>(null);
  const [follow, setFollow] = useState<FollowUp>(noFollowUp);
  // Day 5b (design 7.9, D17): "Open a deal" with Interested and Book meeting, on when the lead has no open deal.
  const [openDeal, setOpenDeal] = useState(false);
  const [dealTitle, setDealTitle] = useState("");
  const [dealValue, setDealValue] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [dials, setDials] = useState<Record<string, Dialled>>({});
  const [noteSheet, setNoteSheet] = useState(false);
  const [stats, setStats] = useState({ calls: 0, talks: 0 });
  const [statsDay, setStatsDay] = useState<string | null>(null);
  const advanced = useRef(false);

  const onEvent = useCallback(
    (e: QueueEvent) => {
      if (e.kind === "logged") {
        // Worded in the effect on q.lastLogged below (its Undo needs the hook's own undo). A card lost in the same answer
        // was swapped quietly: the focus goes to the card that took its place.
        if (e.entry.lostClaim) advanced.current = true;
      } else if (e.kind === "failed") {
        toast.show(tErr(e.error === "invalid" && e.hint ? `hint.${e.hint}` : e.error));
      } else if (e.kind === "undone") {
        // The lead comes back on screen: its heading takes the focus (the card it replaces is leaving and inert).
        if (e.claimed) advanced.current = true;
        toast.show(e.dealKept ? tOut("toast.dealKept") : e.claimed ? tOut("toast.undone") : t("lostClaim"));
      } else if (e.kind === "undoFailed") {
        toast.show(tErr(e.error));
      } else if (e.kind === "released") {
        // Said on the start screen itself (with a link to log a call made meanwhile); the focus goes to Start.
        focusStart.current = true;
      } else {
        // A quiet swap: the next card takes the place (and the focus) of the one a teammate is working.
        advanced.current = true;
        toast.show(e.name ? t("lostClaimNamed", { name: e.name }) : t("lostClaim"));
      }
    },
    [t, tOut, tErr, toast],
  );

  const q = useQueue({ scope: "mine", anyHours: false, skipLunch: false }, onEvent);
  const { settings, setSettings, current, next } = q;

  // "Logged: No answer · back Tue 13 Oct · Undo (U)" for 10 s, once per saved outcome.
  const { lastLogged, undo } = q;
  useEffect(() => {
    if (!lastLogged) return;
    const r = lastLogged.result;
    const parts = [tOut("toast.logged", { what: tOut(lastLogged.outcome) })];
    if (r.editable === false) {
      parts.push(lastLogged.card.owner?.first_name ? tOut("toast.notEditable", { owner: lastLogged.card.owner.first_name }) : tOut("toast.notEditableUnowned"));
    } else {
      if (r.status_after && r.status_after !== r.status_before) parts.push(tOut("toast.status", { status: tStatus(r.status_after as LeadStatus) }));
      if (r.next_action_at && r.status_after !== "do_not_contact") {
        parts.push(tOut("toast.back", { date: format.dateTime(new Date(r.next_action_at), { weekday: "short", day: "numeric", month: "short" }) }));
      }
    }
    // Day 5b: the deal Interested or Book meeting opened, or why it was not (the same words as the call panel's toast).
    if (r.deal?.opened) parts.push(tOut("toast.dealOpened", { stage: tStage("lead") }));
    else if (r.deal && r.deal.reason === "not_editable") {
      parts.push(lastLogged.card.owner?.first_name ? tOut("dealSkipped.not_editable", { owner: lastLogged.card.owner.first_name }) : tOut("dealSkipped.not_editableUnowned"));
    } else if (r.deal) parts.push(tOut(`dealSkipped.${r.deal.reason}`));
    if (lastLogged.lostClaim) parts.push(t("lostClaim"));
    // The polite message already said what was logged and who is next (one announcement per key): the toast is shown,
    // not read out, unless it also says a card went to a teammate.
    toast.show(parts.join(" · "), { label: `${tOut("toast.undo")} (U)`, run: () => void undo() }, { duration: 10_000, quiet: !lastLogged.lostClaim });
    // Once per logged entry: undo changes with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastLogged]);

  // The lunch switch and today's counts are this session's (read once in the browser).
  const mounted = useSyncExternalStore(noop, () => true, () => false);
  const [lunchRead, setLunchRead] = useState(false);
  if (mounted && !lunchRead) {
    setLunchRead(true);
    const lunch = readSkipLunch();
    if (lunch !== settings.skipLunch) setSettings((s) => ({ ...s, skipLunch: lunch }));
  }
  const today = now ? localDate(viewerZone, now) : null;
  if (today && statsDay !== today) {
    setStatsDay(today);
    setStats(readStats(today));
  }

  const summaryQuery = useQuery({
    queryKey: ["queue-summary", settings.scope, settings.skipLunch],
    queryFn: () => fetchSummary(settings.scope, settings.skipLunch),
    initialData: settings.scope === "mine" && !settings.skipLunch && initialSummary ? initialSummary : undefined,
    enabled: q.phase === "start",
    staleTime: 20_000,
  });

  // A new card: its outcome choice, follow-up and note start empty; the focus moves to its heading after the advance
  // (in an effect, after React has committed the new card), unless the person is typing somewhere.
  const currentId = current?.id ?? null;
  const [shownId, setShownId] = useState<string | null>(null);
  if (currentId !== shownId) {
    setShownId(currentId);
    setChoice(null);
    setFollow(noFollowUp);
  }
  useEffect(() => {
    if (!currentId) {
      // Cards loading (after Start, or the reserve ran dry): the page title holds the focus meanwhile.
      const active = document.activeElement;
      if (q.phase === "working" && (!active || active === document.body || !active.isConnected)) titleRef.current?.focus({ preventScroll: true });
      return;
    }
    if (!advanced.current) return;
    advanced.current = false;
    const active = document.activeElement;
    if (active && active !== document.body && isTyping(active)) return;
    // The heading takes the focus on the next frame unless the person moved it meanwhile (N pressed as the card
    // appeared: the note keeps it, so the rest of the typing never turns into keys).
    requestAnimationFrame(() => {
      const now = document.activeElement;
      if (now === active || !now || now === document.body || !now.isConnected) headingRef.current?.focus({ preventScroll: false });
    });
  }, [currentId, q.phase]);
  // Back on the start screen (Done for now, Back to start, the claims ended): Start has the focus, so ↩ starts again.
  // The empty state: its heading has the focus (the card or the title that held it is gone or says less).
  useEffect(() => {
    if (q.phase === "start" && focusStart.current) {
      focusStart.current = false;
      startRef.current?.focus();
    } else if (q.phase === "empty") {
      const active = document.activeElement;
      if (!active || !isTyping(active)) emptyRef.current?.focus();
    }
  }, [q.phase]);

  const dialled = current ? (dials[current.id] ?? defaultDial(current)) : null;
  const note = current ? (notes[current.id] ?? "") : "";
  const onlyDnc = !!current && q.changedStatus === "do_not_contact";
  const dealChoice = choice === "interested" || choice === "meeting_booked";
  const canDeal = !!current && current.can_edit && current.lead_status !== "do_not_contact" && !onlyDnc;
  const dealValueParsed = dealValue.trim() ? parseMoney(dealValue, locale) : null;
  const dealOn = dealChoice && canDeal && openDeal;
  const dealValueBad = dealOn && dealValue.trim() !== "" && dealValueParsed === null;

  const announce = useCallback(
    (what: string, leadName: string) => {
      const n = q.next;
      setLive(
        n
          ? t(what === "skip" ? "liveSkip" : "live", {
              outcome: what,
              lead: leadName,
              next: [
                n.name,
                n.city,
                now ? t("theirTime", { time: format.dateTime(now, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: spanEnds(n.call_zone)?.[0] ?? n.call_zone }) }) : null,
              ]
                .filter(Boolean)
                .join(", "),
            })
          : t("liveEnd", { outcome: what, lead: leadName }),
      );
    },
    [q.next, t, now, format],
  );

  const commit = useCallback(
    (o: CallOutcome, f: FollowUp) => {
      if (!current) return;
      const target = dialled;
      const body = notes[current.id] ?? "";
      advanced.current = true;
      q.logOutcome({
        leadId: current.id,
        type: "call",
        outcome: o,
        body,
        contactId: target?.kind === "contact" ? target.contactId : null,
        dialled: target ? target.kind : null,
        ...followUpArgs(f, viewerZone),
        leadName: current.name,
        requestId: crypto.randomUUID(),
        openDeal: (o === "interested" || o === "meeting_booked") && canDeal && openDeal ? { title: dealTitle.trim() || null, value: dealValueParsed } : null,
      });
      announce(tOut(o), current.name);
      if (today) {
        const s = { calls: stats.calls + 1, talks: stats.talks + (TALKS.includes(o) ? 1 : 0) };
        setStats(s);
        try {
          window.sessionStorage.setItem(statsKey(today), JSON.stringify(s));
        } catch {
          // Counts are a convenience: kept in memory when storage is blocked.
        }
      }
      setNotes((m) => {
        const rest = { ...m };
        delete rest[current.id];
        return rest;
      });
    },
    [current, dialled, notes, q, viewerZone, announce, tOut, today, stats, canDeal, openDeal, dealTitle, dealValueParsed],
  );

  // A key or a pad button: 1–4 log at once; 5, 6 and 0 open their follow-up first; 7 asks once more.
  const pick = useCallback(
    (o: CallOutcome) => {
      if (!current) return;
      if (onlyDnc && o !== "do_not_contact") return;
      if (o === "wrong_number" && !dialled) return;
      const rule = followUpRule("call", o);
      if (o === "do_not_contact" || rule !== "none") {
        setChoice(o);
        setOpenDeal((o === "interested" || o === "meeting_booked") && canDeal && (current.open_deal?.count ?? 0) === 0);
        setDealTitle("");
        setDealValue("");
        setFollow(
          rule === "date_or_time"
            ? { date: nextWorkingDate(new Date(), current.call_zone), time: null }
            : rule === "time"
              ? { date: nextWorkingDate(new Date(), current.call_zone), time: "10:00" }
              : noFollowUp,
        );
        return;
      }
      commit(o, noFollowUp);
    },
    [current, onlyDnc, dialled, commit, canDeal],
  );

  // Cancel the follow-up or the Do not contact question: if the focus was inside it (phones move it there), it goes
  // back to the card's heading instead of the page.
  const cancelChoice = useCallback(() => {
    // The focus goes to the card's heading before the panel (and the Cancel button in it) goes away, so it never drops
    // to the page; the frame after is a fallback in case something else took it and then vanished.
    const active = document.activeElement;
    if (!active || active === document.body || active.closest("[data-queue-panel]")) headingRef.current?.focus();
    setChoice(null);
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected) headingRef.current?.focus();
    });
  }, []);

  const confirm = useCallback(() => {
    if (!choice) return;
    if (choice === "meeting_booked" && (!follow.date || !follow.time)) return;
    if (choice === "interested" && !follow.date) return;
    if (dealValueBad) return;
    commit(choice, follow);
  }, [choice, follow, commit, dealValueBad]);

  const skip = useCallback(() => {
    if (!current) return;
    advanced.current = true;
    announce("skip", current.name);
    q.skip();
  }, [current, q, announce]);

  // Start (or start again): the button that was pressed goes away, so the title holds the focus until the first card's
  // heading takes it.
  const start = useCallback(
    (over?: Partial<{ scope: QueueScope; anyHours: boolean }>) => {
      advanced.current = true;
      titleRef.current?.focus({ preventScroll: true });
      q.start(over);
    },
    [q],
  );
  const stop = useCallback(() => {
    focusStart.current = true;
    q.stop();
  }, [q]);
  // Try again after an error: the button goes away while cards load, so the title holds the focus meanwhile.
  const retry = useCallback(() => {
    advanced.current = true;
    titleRef.current?.focus({ preventScroll: true });
    q.retry();
  }, [q]);

  // Keys: on the start screen ↩ starts and U takes back the latest outcome; while working, digits (by position), S, N,
  // C, U and Cmd/Ctrl+Z; with a follow-up open, ↩ confirms and Esc cancels. Quiet while typing (except ↩/Esc in the follow-up's date and time fields), during
  // IME composition and while a dialog is open. The listener is attached once and always runs the latest handler (set
  // before the browser paints), so a key pressed the moment a new card shows acts on that card, never the one before.
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => {});
  useLayoutEffect(() => {
    keyHandler.current = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (document.querySelector("[role=dialog],[role=menu]")) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const inPicker = target instanceof HTMLInputElement && (target.type === "date" || target.type === "time");
      if (q.phase === "start") {
        if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && (!target || target === document.body || target.tagName === "MAIN")) {
          event.preventDefault();
          start();
          return;
        }
        // Right after Done for now the toast still offers Undo (U): U (or Cmd/Ctrl+Z) takes that outcome back here too.
        if (!isTyping(target) && queueKeyFor(event)?.kind === "undo" && q.canUndo()) {
          event.preventDefault();
          q.undo();
        }
        return;
      }
      if (q.phase !== "working" || !current) {
        // The empty state and the loading card: U (or Cmd/Ctrl+Z) still takes back the latest outcome, as its toast says.
        if (isTyping(target)) return;
        const key = queueKeyFor(event);
        if (key?.kind === "undo" && q.canUndo()) {
          event.preventDefault();
          q.undo();
        }
        return;
      }
      // D toggles "Open a deal" while Interested or Book meeting waits for ↩ (event.key: the letter, wherever it sits).
      if (dealChoice && canDeal && !isTyping(target) && event.key.toLowerCase() === "d" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setOpenDeal((on) => !on);
        return;
      }
      if (choice && (event.key === "Enter" || event.key === "Escape") && (!isTyping(target) || inPicker)) {
        // Confirm and Cancel (and the pad) do their own job; on a date chip, ↩ confirms the follow-up as chosen.
        if (event.key === "Enter" && target?.tagName === "BUTTON" && !target.closest("fieldset")) return;
        event.preventDefault();
        if (event.key === "Enter") confirm();
        else cancelChoice();
        return;
      }
      if (isTyping(target)) {
        if (event.key === "Escape" && target === noteRef.current) {
          event.preventDefault();
          headingRef.current?.focus();
        }
        return;
      }
      const key = queueKeyFor(event);
      if (!key) return;
      event.preventDefault();
      if (key.kind === "outcome") pick(key.outcome);
      else if (key.kind === "skip") skip();
      else if (key.kind === "undo") q.undo();
      else if (key.kind === "note") {
        if (window.matchMedia("(min-width: 1024px)").matches) noteRef.current?.focus();
        else setNoteSheet(true);
      } else if (key.kind === "call") {
        const number = dialNumber(current, dialled);
        if (number) document.querySelector<HTMLAnchorElement>(`a[href="${CSS.escape(callHref(number, current.country))}"]`)?.click();
      }
    };
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => keyHandler.current(event);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const scopes: QueueScope[] = canWide ? ["mine", "mine_unassigned", "team"] : ["mine"];
  const scopeLabel = (s: QueueScope) => t(`scope.${s === "mine_unassigned" ? "mineUnassigned" : s}`);
  const n = (chunks: React.ReactNode) => <span className="font-mono text-lg font-bold tabular-nums">{chunks}</span>;

  // Outcomes whose tries all failed (or that an earlier visit left): said in the header, in every phase, with Retry.
  const notSaved =
    q.notSaved > 0 ? (
      <div role="status" className="flex w-full max-w-[720px] flex-wrap items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-status-amber" />
        <span className="flex-1 font-bold">{t("notSaved", { count: q.notSaved })}</span>
        <Button variant="neutral" className="min-h-11 px-3 text-sm sm:min-h-9" aria-disabled={q.saving || undefined} onClick={() => !q.saving && q.retryPending()}>
          {q.saving ? t("retrying") : t("retry")}
        </Button>
      </div>
    ) : null;

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <Link
          href="/leads"
          prefetch={false}
          className="-ml-2 inline-flex min-h-11 items-center gap-1 self-start rounded-md px-2 text-sm text-muted-foreground transition-[color,transform,scale] duration-150 hover:text-foreground active:scale-[0.97]"
        >
          <ArrowLeft aria-hidden="true" strokeWidth={1.75} className="size-4" />
          {t("back")}
        </Link>
        <h1 ref={titleRef} tabIndex={-1} className="flex flex-wrap items-baseline gap-x-3 text-3xl font-bold focus-visible:outline-offset-4 sm:text-4xl">
          {t("title")}
          {q.phase !== "start" ? <span className="text-base font-normal text-muted-foreground">{scopeLabel(settings.scope)}</span> : null}
        </h1>
      </div>
      {q.phase !== "start" ? (
        <Button variant="quiet" onClick={stop}>
          {t("stop")}
        </Button>
      ) : null}
      {notSaved}
    </div>
  );
  // One polite message across every phase (it stays mounted, so "Logged … for …" is still read when the last card
  // leaves for the empty state).
  const liveRegion = (
    <p aria-live="polite" className="sr-only">
      {live}
    </p>
  );

  // Start screen: scope (admins), the counts, the lunch switch, Start.
  if (q.phase === "start") {
    const s = summaryQuery.data;
    return (
      <div data-owns-undo="" className="flex min-w-0 flex-col gap-6 pt-2">
        {header}
        {liveRegion}
        <section aria-labelledby="queue-counts" className="flex max-w-[720px] min-w-0 flex-col gap-5 rounded-lg bg-card p-5 sm:p-6">
          {q.released ? (
            <div role="status" className="flex flex-col items-start gap-1.5 rounded-md bg-muted p-4">
              <p className="flex items-center gap-2 font-bold">
                <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-status-amber" />
                {t("released.title")}
              </p>
              <p className="max-w-[65ch] text-sm text-muted-foreground">{t("released.body")}</p>
              {q.released.leadId && q.released.leadName ? (
                <Link
                  href={`/leads/${q.released.leadId}`}
                  className="inline-flex min-h-11 items-center text-sm font-bold underline underline-offset-4 transition-transform duration-150 active:scale-[0.97] sm:min-h-8"
                >
                  <span dir="auto">{t("released.logCall", { lead: q.released.leadName })}</span>
                </Link>
              ) : null}
            </div>
          ) : null}
          <p className="max-w-[65ch] text-muted-foreground">{t("intro")}</p>
          {scopes.length > 1 ? (
            // Phones: one row of three, the long middle label wrapping inside its segment (French "Les miens + sans
            // responsable" broke the row into two uneven lines; Day 7c).
            <div
              role="group"
              aria-label={t("scopeLabel")}
              className="flex max-w-full flex-wrap gap-0.5 self-start rounded-md bg-muted p-1 max-sm:grid max-sm:w-full max-sm:grid-cols-[auto_minmax(0,1fr)_auto]"
            >
              {scopes.map((sc) => (
                <button
                  key={sc}
                  type="button"
                  aria-pressed={settings.scope === sc}
                  onClick={() => setSettings((cur) => ({ ...cur, scope: sc }))}
                  className={cn(
                    "min-h-11 shrink-0 rounded-[10px] px-3.5 text-sm whitespace-nowrap transition-[background-color,color,transform,scale] duration-150 active:scale-[0.97] max-sm:py-1 max-sm:leading-tight max-sm:text-balance max-sm:whitespace-normal sm:min-h-9",
                    settings.scope === sc ? "bg-pill text-foreground shadow-[0_1px_3px_rgb(14_14_16/0.12)]" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {scopeLabel(sc)}
                </button>
              ))}
            </div>
          ) : null}
          <div className="flex flex-col gap-2">
            <h2 id="queue-counts" className="text-sm font-bold text-muted-foreground">
              {t("countsLabel")}
            </h2>
            {summaryQuery.isPending ? (
              <div aria-hidden="true" className="flex flex-col gap-2">
                <div className="h-7 w-48 rounded-sm bg-muted motion-safe:animate-pulse" />
                <div className="h-6 w-64 rounded-sm bg-muted motion-safe:animate-pulse" />
              </div>
            ) : summaryQuery.isError || !s ? (
              <div role="alert" className="flex flex-wrap items-center gap-3">
                <p className="text-sm">{t("summaryError")}</p>
                <Button variant="quiet" onClick={() => void summaryQuery.refetch()}>
                  {t("retry")}
                </Button>
              </div>
            ) : (
              <ul className="flex flex-col gap-1">
                <li className="text-base">{t.rich("callableNow", { count: s.callable_now, n })}</li>
                {s.follow_ups_due > 0 ? <li>{t.rich("followUpsDue", { count: s.follow_ups_due, n })}</li> : null}
                <li className="text-muted-foreground">{t.rich("laterToday", { count: s.later_today, n })}</li>
                {s.claimed_by_others > 0 ? <li className="text-muted-foreground">{t.rich("claimedByOthers", { count: s.claimed_by_others, n })}</li> : null}
                {s.no_number > 0 ? <li className="text-muted-foreground">{t.rich("noNumber", { count: s.no_number, n })}</li> : null}
              </ul>
            )}
          </div>
          <label className="flex min-h-11 cursor-pointer items-center gap-3 self-start text-sm">
            <button
              type="button"
              role="switch"
              aria-checked={settings.skipLunch}
              onClick={() => {
                const on = !settings.skipLunch;
                writeSkipLunch(on);
                setSettings((cur) => ({ ...cur, skipLunch: on }));
              }}
              className={cn("relative h-7 w-12 shrink-0 rounded-full transition-[background-color,transform,scale] duration-150 active:scale-[0.97]", settings.skipLunch ? "bg-primary" : "bg-muted ring-1 ring-border ring-inset")}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "absolute top-1 left-1 size-5 rounded-full bg-card shadow-sm transition-transform duration-200",
                  settings.skipLunch && "translate-x-5",
                )}
              />
            </button>
            <span>{t("skipLunch")}</span>
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Button ref={startRef} onClick={() => start()} aria-keyshortcuts="Enter">
              {t("start")}
              <Kbd aria-hidden="true" className="hidden border-transparent bg-brand-foreground/10 text-brand-foreground sm:inline-grid">
                ↩
              </Kbd>
            </Button>
          </div>
        </section>
      </div>
    );
  }

  // Nothing left: all done, outside calling hours, or no leads of one's own.
  if (q.phase === "empty") {
    const reason = emptyReason(q.summary, settings.scope, mineCount > 0, settings.anyHours);
    const opening = reason === "outsideHours" && q.summary && now ? firstOpening(q.summary.waiting_by_zone, now, settings.skipLunch) : null;
    let body: React.ReactNode = null;
    if (reason === "outsideHours" && opening && now) {
      const zone = spanEnds(opening.key)?.[0] ?? opening.key;
      const sameDay = localDate(zone, opening.opensAt) === localDate(zone, now);
      const values = {
        place: placeOf(opening.key, locale),
        time: format.dateTime(opening.opensAt, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: zone }),
        relative: format.relativeTime(opening.opensAt, now),
        day: format.dateTime(opening.opensAt, { weekday: "short", timeZone: zone }),
      };
      body = <p>{sameDay ? t("empty.opensNext", values) : t("empty.opensNextDay", values)}</p>;
    }
    return (
      <div data-owns-undo="" className="flex min-w-0 flex-col gap-6 pt-2">
        {header}
        {liveRegion}
        <section aria-labelledby="queue-empty-title" className="flex max-w-[720px] flex-col items-start gap-3 rounded-lg bg-card p-5 sm:p-6">
          <h2 id="queue-empty-title" ref={emptyRef} tabIndex={-1} className="text-xl font-bold focus-visible:outline-offset-4">
            {reason === "noneMine" ? t("empty.noneMineTitle") : reason === "outsideHours" ? t("empty.outsideHoursTitle") : t("empty.allDoneTitle")}
          </h2>
          {reason === "noneMine" ? <p className="text-muted-foreground">{t("empty.noneMineBody")}</p> : body}
          {reason === "allDone" && q.summary ? (
            <p className="text-muted-foreground">
              {[q.summary.later_today > 0 ? t("empty.laterToday", { count: q.summary.later_today }) : null, q.summary.no_number > 0 ? t("empty.noNumber", { count: q.summary.no_number }) : null]
                .filter(Boolean)
                .join(" ")}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-3 pt-1">
            {reason === "outsideHours" ? (
              <Button variant="neutral" onClick={() => start({ anyHours: true })}>
                {t("showOutside")}
              </Button>
            ) : null}
            {reason === "noneMine" && canWide ? (
              <Button variant="neutral" onClick={() => start({ scope: "mine_unassigned" })}>
                {t("empty.workUnassigned")}
              </Button>
            ) : null}
            <Button variant="quiet" onClick={stop}>
              {t("empty.backToStart")}
            </Button>
          </div>
        </section>
      </div>
    );
  }

  // Working.
  return (
    <div data-owns-undo="" className="flex min-w-0 flex-col gap-5 pt-2">
      {header}
      {liveRegion}
      {q.error && !current ? (
        <div role="alert" className="flex max-w-[720px] flex-col items-start gap-3 rounded-lg bg-card p-5">
          <p className="font-bold">{t("error")}</p>
          <p className="text-sm text-muted-foreground">{tErr(q.error)}</p>
          <Button variant="quiet" onClick={retry}>
            {t("retry")}
          </Button>
        </div>
      ) : !current ? (
        <QueueCardSkeleton label={t("loading")} />
      ) : (
        <div className="relative grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 [grid-template-areas:'head'_'rail'_'details'] lg:grid-cols-[minmax(0,1fr)_360px] lg:grid-rows-[auto_1fr] lg:items-start lg:[grid-template-areas:'head_rail'_'details_rail']">
          <AnimatePresence mode="popLayout" initial={false}>
            <CardShell key={current.id} labelledBy={`queue-card-${current.id}`} reduce={!!reduce}>
              {onlyDnc ? (
                <p role="note" className="flex items-start gap-2 rounded-md bg-muted p-3 text-sm">
                  <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-status-red" />
                  {t("dncChanged", { name: current.name })}
                </p>
              ) : null}
              <QueueCardView
                  ref={headingRef}
                  headingId={`queue-card-${current.id}`}
                  part="head"
                  card={current}
                  next={next}
                  dialled={dialled}
                  onDial={(d) => setDials((m) => ({ ...m, [current.id]: d }))}
                  skipLunch={settings.skipLunch}
                  me={me}
                  profileZone={zone}
                  changedStatus={q.changedStatus}
                  claiming={q.claiming}
                />
            </CardShell>
          </AnimatePresence>
          <aside aria-label={t("padTitle")} className="flex min-w-0 flex-col rounded-lg bg-card p-4 [grid-area:rail] sm:p-5 lg:sticky lg:top-4">
            <QueueRail
              ref={noteRef}
              choice={choice}
              onPick={pick}
              follow={follow}
              onFollow={setFollow}
              onConfirm={confirm}
              onCancel={cancelChoice}
              viewerZone={viewerZone}
              leadZoneKey={current.call_zone}
              now={now ?? new Date()}
              note={note}
              onNote={(v) => setNotes((m) => ({ ...m, [current.id]: v }))}
              onSkip={skip}
              onOpenNote={() => setNoteSheet(true)}
              onlyDnc={onlyDnc}
              noNumber={!dialled}
              stats={stats}
              disabled={false}
              deal={
                canDeal
                  ? {
                      on: openDeal,
                      onToggle: () => setOpenDeal((on) => !on),
                      latest: current.open_deal?.latest ?? null,
                      openCount: current.open_deal?.count ?? 0,
                      title: dealTitle,
                      onTitle: setDealTitle,
                      value: dealValue,
                      onValue: setDealValue,
                      valueBad: dealValueBad,
                    }
                  : null
              }
            />
          </aside>
          <div className="flex min-w-0 flex-col rounded-lg bg-card p-4 [grid-area:details] sm:p-6">
            <QueueCardView
              part="details"
              card={current}
              next={next}
              dialled={dialled}
              onDial={(d) => setDials((m) => ({ ...m, [current.id]: d }))}
              skipLunch={settings.skipLunch}
              me={me}
              profileZone={zone}
              changedStatus={q.changedStatus}
              claiming={q.claiming}
            />
          </div>
        </div>
      )}

      <Dialog open={noteSheet && !!current} onOpenChange={setNoteSheet}>
        <DialogContent className={cn(phoneSheet, "sm:w-[min(520px,calc(100%-32px))]")}>
          <div className="flex flex-col gap-4 p-5">
            <DialogTitle className="text-xl font-bold">{t("noteSheet")}</DialogTitle>
            <DialogDescription className="sr-only">{current?.name}</DialogDescription>
            <textarea
              name="queue_note_sheet"
              aria-label={t("noteSheet")}
              autoComplete="off"
              value={note}
              onChange={(e) => current && setNotes((m) => ({ ...m, [current.id]: e.target.value }))}
              placeholder={t("notePlaceholder")}
              dir="auto"
              rows={4}
              maxLength={10000}
              // The sheet opens only to write the note (N, or Note on phones): the field takes the focus at once.
              autoFocus
              className="min-h-28 rounded-md border border-border bg-background px-3 py-2 text-base text-foreground placeholder:text-muted-foreground"
            />
            <Button variant="neutral" onClick={() => setNoteSheet(false)}>
              {t("noteDone")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * The card's frame: out to the left and in from the right (the `snappy` spring; a key mid-flight starts from where the
 * card is), a short fade with reduced motion. The leaving card is hidden from assistive tech and inert, so only the new
 * card is announced and focusable.
 */
function CardShell({ labelledBy, reduce, children }: { labelledBy: string; reduce: boolean; children: React.ReactNode }) {
  const present = useIsPresent();
  return (
    <motion.section
      aria-labelledby={labelledBy}
      role="region"
      aria-hidden={present ? undefined : true}
      inert={!present}
      data-leaving={present ? undefined : ""}
      initial={reduce ? { opacity: 0 } : { opacity: 0, x: 32 }}
      animate={{ opacity: 1, x: 0 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, x: -32 }}
      transition={reduce ? { duration: 0.12 } : springs.snappy}
      className="relative flex min-w-0 flex-col gap-4 rounded-lg bg-card p-4 [grid-area:head] sm:p-6"
    >
      {children}
    </motion.section>
  );
}

/** The card and the rail as they will be: the working screen's loading state (and the route's). */
export function QueueCardSkeleton({ label }: { label?: string }) {
  const bar = "rounded-sm bg-muted motion-safe:animate-pulse";
  return (
    <div aria-busy="true" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
      {label ? <span className="sr-only">{label}</span> : null}
      <div className="flex flex-col gap-4 rounded-lg bg-card p-4 sm:p-6">
        <div className="flex gap-3">
          <div className={`h-7 w-28 ${bar}`} />
          <div className={`h-7 w-20 ${bar}`} />
        </div>
        <div className={`h-8 w-2/3 sm:h-9 ${bar}`} />
        <div className={`h-5 w-72 max-w-full ${bar}`} />
        <div className="flex flex-wrap items-center gap-3">
          <div className={`h-14 w-full rounded-md sm:h-12 sm:w-32 ${bar}`} />
          <div className={`h-8 w-56 ${bar}`} />
        </div>
      </div>
      <div className="flex flex-col gap-3 rounded-lg bg-card p-4 sm:p-5 lg:row-span-2">
        <div className={`h-5 w-32 ${bar}`} />
        <div className="grid grid-cols-2 gap-1.5 lg:grid-cols-1">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className={`h-14 rounded-md sm:h-11 ${bar}`} />
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-3 rounded-lg bg-card p-4 sm:p-6">
        <div className={`h-5 w-24 ${bar}`} />
        <div className={`h-14 ${bar}`} />
        <div className={`h-5 w-28 ${bar}`} />
        <div className={`h-12 ${bar}`} />
      </div>
    </div>
  );
}
