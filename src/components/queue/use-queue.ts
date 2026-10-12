"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { releaseClaims, renewClaims, startQueue, undoOutcome } from "@/app/(app)/leads/queue/actions";
import { fetchLead } from "@/components/leads/use-leads";
import type { CallOutcome, LoggedActivity } from "@/lib/activities";
import type { ActionResult, AppError } from "@/lib/db-errors";
import {
  ACTIVE_WINDOW_MS,
  RENEW_EVERY_MS,
  RETRY_DELAYS_MS,
  addExcluded,
  addPending,
  claimCount,
  readPending,
  removePending,
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

export type QueuePhase = "start" | "working" | "empty";
export type LoggedEntry = { activityId: string; card: QueueCard; outcome: CallOutcome; until: number; result: LoggedActivity };
export type QueueEvent =
  | { kind: "logged"; entry: LoggedEntry }
  | { kind: "failed"; error: AppError; hint?: string; leadName: string }
  | { kind: "undone"; claimed: boolean; leadName: string }
  | { kind: "undoFailed"; error: AppError }
  | { kind: "lostClaim" };

type Settings = { scope: QueueScope; anyHours: boolean; skipLunch: boolean };
type Card = QueueCard & { receivedAt: number };

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

  /** New cards go behind the ones on screen (never one twice); no card left and none found: the empty state. */
  const take = useCallback(
    (answer: ClaimAnswer | null) => {
      if (!answer) return;
      const now = Date.now();
      setCards((cur) => {
        const known = new Set(cur.map((c) => c.id));
        return [...cur, ...answer.cards.filter((c) => !known.has(c.id)).map((c) => ({ ...c, receivedAt: now }))];
      });
      if (cardsRef.current.length === 0) {
        setSummary(answer.summary);
        setPhase("empty");
      }
    },
    [setCards],
  );

  const refill = useCallback(() => {
    setClaiming(true);
    void enqueue(async () => {
      const next = nextRequest();
      if (!next || phaseRef.current !== "working") {
        setClaiming(false);
        return;
      }
      const res = await claimMore(next);
      setClaiming(false);
      if (res.ok) take(res.data);
      else if (cardsRef.current.length === 0) setError(res.error);
    });
  }, [enqueue, nextRequest, take]);

  const start = useCallback(
    (over?: Partial<Settings>) => {
      const s = { ...settingsRef.current, ...over };
      settingsRef.current = s;
      setSettings(s);
      setPhase("working");
      setError(null);
      setSummary(null);
      setCards(() => []);
      lastInput.current = Date.now();
      setClaiming(true);
      void enqueue(async () => {
        const res = await safe(startQueue({ scope: s.scope, exclude: excludeRef.current, anyHours: s.anyHours, skipLunch: s.skipLunch }));
        setClaiming(false);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        take(res.data);
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
        for (const d of delays) {
          if (d) await wait(d);
          const next = phaseRef.current === "working" ? nextRequest() : null;
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
        if (card && logged.undo_until) {
          const entry: LoggedEntry = { activityId: logged.activity_id, card, outcome: item.input.outcome as CallOutcome, until: Date.parse(logged.undo_until), result: logged };
          setLastLogged(entry);
          eventRef.current({ kind: "logged", entry });
        }
        if (res.data.claim) take(res.data.claim);
        else if (res.data.claimError && cardsRef.current.length === 0) setError(res.data.claimError);
      })),
    [enqueue, nextRequest, refill, take, removeStuck],
  );

  /** An outcome for the current card: the next card shows at once; the outcome is kept until the database has it. */
  const logOutcome = useCallback(
    (input: PendingOutcome["input"]) => {
      const card = cardsRef.current[0];
      if (!card || card.id !== input.leadId) return;
      lastInput.current = Date.now();
      const item: PendingOutcome = { input, leadName: card.name, at: Date.now() };
      addPending(item);
      excludeRef.current = addExcluded(excludeRef.current, card.id);
      setCards((cur) => cur.slice(1));
      void save(item, card);
    },
    [save, setCards],
  );

  const skip = useCallback(() => {
    const card = cardsRef.current[0];
    if (!card) return;
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
      const res = await claimMore(next);
      setClaiming(false);
      if (res.ok) take(res.data);
      else if (cardsRef.current.length === 0) setError(res.error);
    });
  }, [enqueue, nextRequest, setCards, take]);

  /** Takes back the last outcome (2 minutes) and puts its lead back on screen, if nobody took it meanwhile. */
  const undo = useCallback(() => {
    const last = lastLogged;
    if (!last || last.until <= Date.now()) return false;
    lastInput.current = Date.now();
    setLastLogged(null);
    void enqueue(async () => {
      const res = await safe(undoOutcome({ activityId: last.activityId, leadId: last.card.id }));
      if (!res.ok) {
        eventRef.current({ kind: "undoFailed", error: res.error });
        return;
      }
      if (res.data.claimed) {
        excludeRef.current = excludeRef.current.filter((id) => id !== last.card.id);
        setCards((cur) => [{ ...last.card, receivedAt: Date.now() }, ...cur.filter((c) => c.id !== last.card.id)].slice(0, 3));
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
    if (ids.length) void enqueue(async () => void (await safe(releaseClaims({ ids: ids.slice(0, 3) }))));
  }, [enqueue, setCards]);

  // A card that waited in reserve is read again when it is shown: a lead marked Do not contact meanwhile gets a banner.
  const current = cards[0];
  useEffect(() => {
    if (!current || Date.now() - current.receivedAt < 15_000) return;
    let gone = false;
    fetchLead(current.id)
      .then((lead) => {
        if (!gone && lead && lead.lead_status !== current.lead_status) setChanged((m) => ({ ...m, [current.id]: lead.lead_status }));
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [current]);

  // Outcomes kept by an earlier visit of this tab are shown as not saved, with Retry.
  useEffect(() => {
    // Read once after mount (sessionStorage is not on the server); a subscription would be heavier for one value.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStuck(readPending().map((p) => p.input.requestId));
  }, []);

  // Renewal every 4 minutes while visible and in use (a key or a click in the last 10 minutes).
  useEffect(() => {
    const mark = () => (lastInput.current = Date.now());
    window.addEventListener("keydown", mark);
    window.addEventListener("pointerdown", mark);
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || cardsRef.current.length === 0) return;
      if (Date.now() - lastInput.current > ACTIVE_WINDOW_MS) return;
      void enqueue(async () => void (await safe(renewClaims())));
    }, RENEW_EVERY_MS);
    return () => {
      window.removeEventListener("keydown", mark);
      window.removeEventListener("pointerdown", mark);
      window.clearInterval(timer);
    };
  }, [enqueue]);

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
