"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { releaseClaims, renewClaims, startQueue, undoOutcome } from "@/app/(app)/leads/queue/actions";
import { fetchLead } from "@/components/leads/use-leads";
import type { CallOutcome, LoggedActivity } from "@/lib/activities";
import type { ActionResult, AppError } from "@/lib/db-errors";
import {
  ACTIVE_WINDOW_MS,
  CLAIM_CHECK_MS,
  CLAIM_MS,
  RENEW_EVERY_MS,
  RETRY_DELAYS_MS,
  addExcluded,
  addPending,
  claimCount,
  claimsStale,
  lostKept,
  readPending,
  removePending,
  renewedUntil,
  type ClaimAnswer,
  type ClaimNextInput,
  type PendingOutcome,
  type QueueCard,
  type QueueScope,
  type QueueSummary,
} from "@/lib/queue";

// The queue's engine (Day 4 design 5.4 and D3). The screen holds the current card and one claimed card in reserve, so a
// key press shows the next card at once from memory; the outcome is then saved and the next reserve claimed in ONE
// server action. Every server call goes through one chain, in order: the cards to keep are worked out when a call
// starts, never when its key was pressed, so two quick keys cannot drop each other's claims. An outcome is written to
// sessionStorage before it is sent (with its request id, so a second send is a replay) and tried again after 0.5, 1 and
// 2 s; then the screen offers Retry. Claims are renewed every 4 minutes while the page is visible and in use, and let
// go when the tab goes away (pagehide: a keepalive request) or the queue is left inside the app.
// A card never stays on screen once its claim may have ended (a lead is on one screen only): each card knows until when
// it is held (the request's start plus 10 minutes, renewed with each claim call and renewal); a card the database no
// longer keeps (claim_next_lead's `kept`) or that a teammate is working when it is read again leaves at once ("A
// teammate is on that one now"); and when the claims end (10 minutes without a key or a click, or renew_claims finds
// none) the cards go and the start screen says so, with a link to log a call made on the card that was showing.

export type QueuePhase = "start" | "working" | "empty";
/** A saved outcome; `lostClaim`: the same answer took a card off the screen (a teammate is on it), said in one toast. */
export type LoggedEntry = { activityId: string; card: QueueCard; outcome: CallOutcome; until: number; result: LoggedActivity; lostClaim: boolean };
export type QueueEvent =
  | { kind: "logged"; entry: LoggedEntry }
  | { kind: "failed"; error: AppError; hint?: string; leadName: string }
  | { kind: "undone"; claimed: boolean; leadName: string }
  | { kind: "undoFailed"; error: AppError }
  | { kind: "lostClaim"; name: string | null }
  | { kind: "released" };

type Settings = { scope: QueueScope; anyHours: boolean; skipLunch: boolean };
type Card = QueueCard & { receivedAt: number; claimedUntil: number };
/** The start screen after the claims ended: the lead that was showing (its call can still be logged on its page). */
export type ReleasedNotice = { leadId: string | null; leadName: string | null };

const retryable = (e: AppError) => e === "unavailable" || e === "busy" || e === "rate_limited";
const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
/**
 * The key-press path goes to route handlers (design D3's switch rule): JSON in, {ok, data} or {ok: false, error} out.
 * A lost connection, a server error or an expired session (401: sign in again, then Retry) reads as "unavailable", so
 * the outcome is kept and tried again; a refused origin as "forbidden".
 */
async function postJson<T>(url: string, body: unknown): Promise<ActionResult<T>> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 403) return { ok: false, error: "forbidden" };
    if (res.status === 400 || res.status === 413 || res.status === 415) return { ok: false, error: "invalid" };
    if (!res.ok) return { ok: false, error: "unavailable" };
    return (await res.json()) as ActionResult<T>;
  } catch {
    return { ok: false, error: "unavailable" };
  }
}
const claimMore = (next: ClaimNextInput) => postJson<ClaimAnswer>("/api/queue/next", { next });
const logOutcomeAndClaim = (body: { log: PendingOutcome["input"]; next: ClaimNextInput | null }) => postJson<QueueOutcomeResult>("/api/queue/outcome", body);
type QueueOutcomeResult = { logged: LoggedActivity; claim: ClaimAnswer | null; claimError: AppError | null };

async function safe<T>(p: Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await p;
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

export function useQueue(initial: Settings, onEvent: (e: QueueEvent) => void) {
  const [phase, setPhase] = useState<QueuePhase>("start");
  const [settings, setSettings] = useState<Settings>(initial);
  const [cards, setCardsState] = useState<Card[]>([]);
  const [summary, setSummary] = useState<QueueSummary | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [claiming, setClaiming] = useState(false);
  // Outcomes kept in this tab whose tries have all failed (or that an earlier visit left): the "not saved" chip. An
  // outcome still being tried is not counted, so the chip appears only after the last try (0.5, 1 and 2 s).
  const [stuck, setStuck] = useState<string[]>([]);
  const [saving, setSaving] = useState(0);
  const [lastLogged, setLastLogged] = useState<LoggedEntry | null>(null);
  const [changed, setChanged] = useState<Record<string, string>>({});
  const [released, setReleased] = useState<ReleasedNotice | null>(null);

  const cardsRef = useRef<Card[]>([]);
  const settingsRef = useRef(settings);
  const excludeRef = useRef<string[]>([]);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const lastInput = useRef(0);
  const phaseRef = useRef<QueuePhase>("start");
  const eventRef = useRef(onEvent);
  useEffect(() => {
    eventRef.current = onEvent;
  }, [onEvent]);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const setCards = useCallback((update: (cur: Card[]) => Card[]) => {
    cardsRef.current = update(cardsRef.current);
    setCardsState(cardsRef.current);
  }, []);

  // One server call at a time, in order (Next.js runs a client's actions one at a time anyway).
  const enqueue = useCallback((job: () => Promise<void>) => {
    const next = chain.current.then(job).catch(() => {});
    chain.current = next;
    return next;
  }, []);

  /** What the next claim asks for, worked out now: the card(s) the screen holds are kept. */
  const nextRequest = useCallback((): ClaimNextInput | null => {
    const held = cardsRef.current.map((c) => c.id);
    if (claimCount(held.length) === 0) return null;
    const s = settingsRef.current;
    return { scope: s.scope, keep: held.slice(0, 1), exclude: excludeRef.current, anyHours: s.anyHours, skipLunch: s.skipLunch };
  }, []);

  /**
   * A claim answer for a request that started at `sentAt` and asked to keep `keep`: the kept cards the database no
   * longer holds for the caller leave the screen (a quiet swap, with a toast when one was showing), the kept ones are
   * held 10 more minutes, and new cards go behind (never one twice). No card left and none found: the empty state.
   * Answers true when a card was lost.
   */
  const take = useCallback(
    (answer: ClaimAnswer | null, keep: readonly string[] | null, sentAt: number, quiet = false) => {
      if (!answer) return false;
      const now = Date.now();
      const lost = new Set(lostKept(keep, answer.kept));
      const wasShown = cardsRef.current.some((c) => lost.has(c.id));
      setCards((cur) => {
        const held = cur.filter((c) => !lost.has(c.id)).map((c) => (keep?.includes(c.id) ? { ...c, claimedUntil: sentAt + CLAIM_MS } : c));
        const known = new Set(held.map((c) => c.id));
        const fresh = answer.cards.filter((c) => !known.has(c.id) && !lost.has(c.id)).map((c) => ({ ...c, receivedAt: now, claimedUntil: sentAt + CLAIM_MS }));
        return [...held, ...fresh];
      });
      if (wasShown && !quiet) eventRef.current({ kind: "lostClaim", name: null });
      if (cardsRef.current.length === 0) {
        if (wasShown && !answer.summary) return true; // the caller's refill below asks again
        setSummary(answer.summary);
        setPhase("empty");
      }
      return wasShown;
    },
    [setCards],
  );

  // A card lost to a teammate is replaced at once: the claim calls ask again through this (set to refill below).
  const refillRef = useRef<() => void>(() => {});
  const refill = useCallback(() => {
    setClaiming(true);
    void enqueue(async () => {
      const next = nextRequest();
      if (!next || phaseRef.current !== "working") {
        setClaiming(false);
        return;
      }
      const sentAt = Date.now();
      const res = await claimMore(next);
      setClaiming(false);
      if (res.ok) {
        if (take(res.data, next.keep, sentAt) && cardsRef.current.length < 2 && phaseRef.current === "working") refillRef.current();
      } else if (cardsRef.current.length === 0) setError(res.error);
    });
  }, [enqueue, nextRequest, take]);
  useEffect(() => {
    refillRef.current = refill;
  }, [refill]);

  const start = useCallback(
    (over?: Partial<Settings>) => {
      const s = { ...settingsRef.current, ...over };
      settingsRef.current = s;
      setSettings(s);
      setPhase("working");
      setError(null);
      setSummary(null);
      setReleased(null);
      setCards(() => []);
      lastInput.current = Date.now();
      setClaiming(true);
      void enqueue(async () => {
        const sentAt = Date.now();
        const res = await safe(startQueue({ scope: s.scope, exclude: excludeRef.current, anyHours: s.anyHours, skipLunch: s.skipLunch }));
        setClaiming(false);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        take(res.data, null, sentAt);
      });
    },
    [enqueue, setCards, take],
  );

  const removeStuck = useCallback((id: string, add = false) => {
    setStuck((list) => {
      const rest = list.filter((x) => x !== id);
      return add ? [...rest, id] : rest;
    });
  }, []);

  /** Sends one kept outcome (with the next claim when the screen needs one), trying again on a lost connection. */
  const save = useCallback(
    (item: PendingOutcome, card: QueueCard | null, retry = true) =>
      // Counted from the moment it is queued, so the screen never claims on its own while an outcome waits its turn.
      (setSaving((n) => n + 1),
      enqueue(async () => {
        const delays = retry ? [0, ...RETRY_DELAYS_MS] : [0];
        let res: Awaited<ReturnType<typeof logOutcomeAndClaim>> = { ok: false, error: "unavailable" };
        let next: ClaimNextInput | null = null;
        let sentAt = 0;
        for (const d of delays) {
          if (d) await wait(d);
          next = phaseRef.current === "working" ? nextRequest() : null;
          sentAt = Date.now();
          res = await logOutcomeAndClaim({ log: item.input, next });
          if (res.ok || !retryable(res.error)) break;
        }
        setSaving((n) => n - 1);
        if (!res.ok) {
          if (retryable(res.error)) {
            removeStuck(item.input.requestId, true);
          } else {
            removePending(item.input.requestId);
            removeStuck(item.input.requestId);
            eventRef.current({ kind: "failed", error: res.error, hint: res.hint, leadName: item.leadName });
          }
          if (cardsRef.current.length === 0 && phaseRef.current === "working") refill();
          return;
        }
        removePending(item.input.requestId);
        removeStuck(item.input.requestId);
        const logged = res.data.logged;
        const toastable = !!(card && logged.undo_until);
        // The next card first (a lost card is said in the "Logged" toast, or on its own when there is none).
        const lost = res.data.claim ? take(res.data.claim, next?.keep ?? null, sentAt, toastable) : false;
        if (card && logged.undo_until) {
          const entry: LoggedEntry = { activityId: logged.activity_id, card, outcome: item.input.outcome as CallOutcome, until: Date.parse(logged.undo_until), result: logged, lostClaim: lost };
          setLastLogged(entry);
          eventRef.current({ kind: "logged", entry });
        }
        if (lost && cardsRef.current.length < 2 && phaseRef.current === "working") refill();
        if (!res.data.claim && res.data.claimError && cardsRef.current.length === 0) setError(res.data.claimError);
      })),
    [enqueue, nextRequest, refill, take, removeStuck],
  );

  /**
   * The claims ended (no key or click for 10 minutes, or renew_claims found none): the cards leave the screen, their
   * claims are let go (if any is left), and the start screen says so, naming the lead that was showing.
   */
  const releaseAll = useCallback(() => {
    const shown = cardsRef.current[0] ?? null;
    const ids = cardsRef.current.map((c) => c.id);
    setCards(() => []);
    setPhase("start");
    setError(null);
    setReleased({ leadId: shown?.id ?? null, leadName: shown?.name ?? null });
    eventRef.current({ kind: "released" });
    if (ids.length) void enqueue(async () => void (await safe(releaseClaims({ ids: ids.slice(0, 3) }))));
  }, [enqueue, setCards]);

  /** True (and the cards go) when a card on screen may no longer be held. */
  const checkHeld = useCallback(() => {
    if (phaseRef.current !== "working" || cardsRef.current.length === 0) return true;
    if (!claimsStale(cardsRef.current, Date.now())) return true;
    releaseAll();
    return false;
  }, [releaseAll]);

  /** An outcome for the current card: the next card shows at once; the outcome is kept until the database has it. */
  const logOutcome = useCallback(
    (input: PendingOutcome["input"]) => {
      const card = cardsRef.current[0];
      if (!card || card.id !== input.leadId) return;
      if (!checkHeld()) return;
      lastInput.current = Date.now();
      const item: PendingOutcome = { input, leadName: card.name, at: Date.now() };
      addPending(item);
      excludeRef.current = addExcluded(excludeRef.current, card.id);
      setCards((cur) => cur.slice(1));
      void save(item, card);
    },
    [save, setCards, checkHeld],
  );

  const skip = useCallback(() => {
    const card = cardsRef.current[0];
    if (!card) return;
    if (!checkHeld()) return;
    lastInput.current = Date.now();
    excludeRef.current = addExcluded(excludeRef.current, card.id);
    setCards((cur) => cur.slice(1));
    setClaiming(true);
    void enqueue(async () => {
      const next = nextRequest();
      if (!next) {
        await safe(releaseClaims({ ids: [card.id] }));
        setClaiming(false);
        return;
      }
      const sentAt = Date.now();
      const res = await claimMore(next);
      setClaiming(false);
      if (res.ok) {
        if (take(res.data, next.keep, sentAt) && cardsRef.current.length < 2 && phaseRef.current === "working") refillRef.current();
      } else if (cardsRef.current.length === 0) setError(res.error);
    });
  }, [enqueue, nextRequest, setCards, take, checkHeld]);

  /** Takes back the last outcome (2 minutes) and puts its lead back on screen, if nobody took it meanwhile. */
  const undo = useCallback(() => {
    const last = lastLogged;
    if (!last || last.until <= Date.now()) return false;
    lastInput.current = Date.now();
    setLastLogged(null);
    void enqueue(async () => {
      const sentAt = Date.now();
      const res = await safe(undoOutcome({ activityId: last.activityId, leadId: last.card.id }));
      if (!res.ok) {
        eventRef.current({ kind: "undoFailed", error: res.error });
        return;
      }
      if (res.data.claimed) {
        excludeRef.current = excludeRef.current.filter((id) => id !== last.card.id);
        setCards((cur) => [{ ...last.card, receivedAt: Date.now(), claimedUntil: sentAt + CLAIM_MS }, ...cur.filter((c) => c.id !== last.card.id)].slice(0, 3));
        setPhase("working");
      }
      eventRef.current({ kind: "undone", claimed: res.data.claimed, leadName: last.card.name });
    });
    return true;
  }, [lastLogged, enqueue, setCards]);

  /** Sends the outcomes kept in this tab again (Retry, or a reload with outcomes not saved). */
  const retryPending = useCallback(() => {
    for (const item of readPending()) void save(item, null, false);
  }, [save]);

  /** Leaves the queue inside the app: the claims go, the start screen comes back. */
  const stop = useCallback(() => {
    const ids = cardsRef.current.map((c) => c.id);
    setCards(() => []);
    setPhase("start");
    setReleased(null);
    if (ids.length) void enqueue(async () => void (await safe(releaseClaims({ ids: ids.slice(0, 3) }))));
  }, [enqueue, setCards]);

  // A card that waited in reserve is read again when it is shown: a lead marked Do not contact meanwhile gets a banner,
  // and a lead a teammate is working now (get_lead's worked_by names anyone but the caller) leaves the screen.
  const current = cards[0];
  useEffect(() => {
    if (!current || Date.now() - current.receivedAt < 15_000) return;
    let gone = false;
    fetchLead(current.id)
      .then((lead) => {
        if (gone || !lead) return;
        if (lead.worked_by) {
          if (!cardsRef.current.some((c) => c.id === current.id)) return;
          setCards((cur) => cur.filter((c) => c.id !== current.id));
          eventRef.current({ kind: "lostClaim", name: lead.worked_by.first_name || null });
          if (cardsRef.current.length < 2 && phaseRef.current === "working") refillRef.current();
          return;
        }
        if (lead.lead_status !== current.lead_status) setChanged((m) => ({ ...m, [current.id]: lead.lead_status }));
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [current, setCards]);

  // Outcomes kept by an earlier visit of this tab are shown as not saved, with Retry.
  useEffect(() => {
    // Read once after mount (sessionStorage is not on the server); a subscription would be heavier for one value.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStuck(readPending().map((p) => p.input.requestId));
  }, []);

  // Renewal every 4 minutes while visible and in use (a key or a click in the last 10 minutes). A renewal that finds no
  // live claim while cards are on screen means they are not held any more: they go.
  useEffect(() => {
    const mark = () => (lastInput.current = Date.now());
    window.addEventListener("keydown", mark);
    window.addEventListener("pointerdown", mark);
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || cardsRef.current.length === 0) return;
      if (Date.now() - lastInput.current > ACTIVE_WINDOW_MS) return;
      void enqueue(async () => {
        if (phaseRef.current !== "working" || cardsRef.current.length === 0) return;
        const sentAt = Date.now();
        const res = await safe(renewClaims());
        if (!res.ok || phaseRef.current !== "working" || cardsRef.current.length === 0) return;
        if (res.data.until === null) releaseAll();
        else setCards((cur) => renewedUntil(cur, sentAt));
      });
    }, RENEW_EVERY_MS);
    return () => {
      window.removeEventListener("keydown", mark);
      window.removeEventListener("pointerdown", mark);
      window.clearInterval(timer);
    };
  }, [enqueue, releaseAll, setCards]);

  // Are the cards on screen still held? Checked every 15 seconds and when the tab comes back into view (a background
  // tab's timers are slowed down), and before every key acts.
  useEffect(() => {
    const timer = window.setInterval(() => void checkHeld(), CLAIM_CHECK_MS);
    const onVisible = () => document.visibilityState === "visible" && void checkHeld();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [checkHeld]);

  // The tab goes away (closed, reloaded, sent to the background for good): a keepalive request lets the claims go. Back
  // from the browser's page cache, the claims are gone: start again from the start screen.
  useEffect(() => {
    const onHide = () => {
      const ids = cardsRef.current.map((c) => c.id).slice(0, 3);
      if (ids.length === 0) return;
      try {
        void fetch("/api/queue/release", {
          method: "POST",
          keepalive: true,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids }),
        }).catch(() => {});
      } catch {
        // The browser refused the request: the claims end by themselves within 10 minutes.
      }
    };
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      setCards(() => []);
      setPhase("start");
    };
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
      // Leaving the queue inside the app: let the claims go.
      const ids = cardsRef.current.map((c) => c.id).slice(0, 3);
      if (ids.length) void safe(releaseClaims({ ids }));
    };
  }, [setCards]);

  return {
    phase,
    settings,
    setSettings,
    cards,
    current: cards[0] ?? null,
    next: cards[1] ?? null,
    summary,
    error,
    claiming,
    notSaved: stuck.length,
    saving: saving > 0,
    lastLogged,
    changedStatus: current ? (changed[current.id] ?? null) : null,
    released,
    start,
    logOutcome,
    skip,
    undo,
    retryPending,
    stop,
    retry: () => {
      setError(null);
      if (cardsRef.current.length === 0) start();
    },
  };
}
