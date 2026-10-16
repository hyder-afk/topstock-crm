"use client";

import { use, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Button } from "@/components/ui/button";
import { useShell } from "@/components/shell/keyboard-layer";
import { buildAnnouncements, buildInstructions } from "@/components/pipeline/announcements";
import { BoardToolbar } from "@/components/pipeline/board-toolbar";
import { ClosedDealsDialog } from "@/components/pipeline/closed-deals";
import { Column } from "@/components/pipeline/column";
import { makeColumnJump } from "@/components/pipeline/coordinate-getter";
import { BoardHandlersContext, DealCardGhost, type BoardHandlers } from "@/components/pipeline/deal-card";
import { useDealFlows } from "@/components/pipeline/deal-flows";
import type { DealMenuActions } from "@/components/pipeline/deal-menu";
import { DealSheet } from "@/components/pipeline/deal-sheet";
import { LostBand } from "@/components/pipeline/lost-band";
import { OpenDealSheet } from "@/components/pipeline/open-deal-sheet";
import { cardElement, settle, type SettleFrom } from "@/components/pipeline/settle";
import { pageKeyAction } from "@/components/pipeline/use-board-keys";
import { lastUndoableMove, useBoard } from "@/components/pipeline/use-pipeline";
import {
  BOARD_PAGE,
  boardColumns,
  type Board,
  type BoardColumnKey,
  type Cursor,
  type DealCard,
  type OpenStageKey,
  type SortOrder,
} from "@/lib/deals";
import type { TeamMember } from "@/lib/leads";
import { formatMoney } from "@/lib/money";
import { appendPage, applyMove, cardsOf, findCard, sortLoaded } from "@/lib/pipeline-cache";
import { boardKey } from "@/lib/prefetch";
import { isTyping } from "@/lib/shortcuts";
import { useKeepFocus } from "@/lib/use-keep-focus";
import { cn } from "@/lib/utils";

// Offline: no sensors at all. `undefined` would make DndContext fall back to its default Pointer and Keyboard sensors,
// so a drag made offline still started and its move was sent once the network came back (WebKit e2e, PR #17).
const NO_SENSORS: ReturnType<typeof useSensors> = [];

// The pipeline board (Day 5 design 7.1 to 7.8). The server page hands over a promise of the first paint; the board
// renders from the query cache at once when the dock already warmed it (D32), otherwise it waits for that promise under
// the page's Suspense skeleton (spike S14). Four columns (Lead, Qualified, Negotiations, Closed/won over the last 30 days)
// and the Lost line; drag with dnd-kit (mouse after 6 px, touch after a 250 ms hold, keyboard with Space and the arrows),
// Shift+arrows and digits on a focused card, the card menu and the deal sheet's stepper all reach the same move_deal.

const pointerFirst: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length ? hits : rectIntersection(args);
};

const phoneQuery = "(max-width: 767.98px)";
function subscribeMedia(cb: () => void) {
  const mq = window.matchMedia(phoneQuery);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
function subscribeOnline(cb: () => void) {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
}

function writeUrl(mut: (url: URL) => void) {
  const url = new URL(window.location.href);
  mut(url);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
}

type Me = { id: string; role: TeamMember["role"] };

export function PipelineView({
  boardPromise,
  team,
  me,
  stepUpSeconds,
  initialDeal,
  initialStalled,
  initialNew,
}: {
  boardPromise: Promise<Board | null>;
  team: TeamMember[];
  me: Me;
  stepUpSeconds: number;
  initialDeal: string | null;
  initialStalled: boolean;
  initialNew: boolean;
}) {
  const qc = useQueryClient();
  // Cache first (D32): the dock's prefetch, or an earlier visit in this tab. Otherwise the server's promise (Suspense).
  const cached = qc.getQueryData<Board>(boardKey("team", null));
  const first = cached ?? use(boardPromise);
  if (!first) return <BoardError />;
  return (
    <Pipeline
      first={first}
      team={team}
      me={me}
      stepUpSeconds={stepUpSeconds}
      initialDeal={initialDeal}
      initialStalled={initialStalled}
      initialNew={initialNew}
    />
  );
}

function BoardError() {
  const t = useTranslations("Pipeline");
  const router = useRouter();
  return (
    <div role="alert" className="flex flex-col items-start gap-3 pt-4">
      <h1 className="text-3xl font-bold sm:text-4xl">{t("title")}</h1>
      <p className="text-muted-foreground">{t("loadFailed")}</p>
      <Button variant="quiet" onClick={() => router.refresh()}>
        {t("retry")}
      </Button>
    </div>
  );
}

// dnd-kit options as constants (stable identities: see the sensors in Pipeline).
const MOUSE_OPTIONS = { activationConstraint: { distance: 6 } };
const TOUCH_OPTIONS = { activationConstraint: { delay: 250, tolerance: 8 } };
const KEYBOARD_CODES = { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] };
const MEASURING = { droppable: { strategy: MeasuringStrategy.WhileDragging } };
const AUTO_SCROLL = { threshold: { x: 0.15, y: 0.2 }, acceleration: 12 };

function Pipeline({
  first,
  team,
  me,
  stepUpSeconds,
  initialDeal,
  initialStalled,
  initialNew,
}: {
  first: Board;
  team: TeamMember[];
  me: Me;
  stepUpSeconds: number;
  initialDeal: string | null;
  initialStalled: boolean;
  initialNew: boolean;
}) {
  const t = useTranslations("Pipeline");
  const tStage = useTranslations("Stages");
  const tAnn = useTranslations("Pipeline.announce");
  const tReason = useTranslations("LostReasons");
  const locale = useLocale();
  const format = useFormatter();
  const router = useRouter();
  const qc = useQueryClient();
  const shell = useShell();
  const reduce = useReducedMotion() ?? false;
  const canTeam = me.role === "admin" || me.role === "manager";
  const phone = useSyncExternalStore(subscribeMedia, () => window.matchMedia(phoneQuery).matches, () => false);
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);

  const [scope, setScope] = useState<"team" | "mine">(canTeam ? "team" : "mine");
  const [owner, setOwner] = useState<string | null>(null);
  const [order, setOrder] = useState<SortOrder>("recent");
  const [stalledOnly, setStalledOnly] = useState(initialStalled);
  const [extraPages, setExtraPages] = useState(false);
  const key = useMemo(() => ({ scope: canTeam ? scope : ("team" as const), owner: canTeam && scope === "team" ? owner : null }), [canTeam, scope, owner]);
  // The scope for the strict reads (a column's next page, See all won / lost): a rep may only ask for their own deals.
  // The board itself keeps the "team" key (its first paint quietly narrows a rep to their own deals), but
  // list_stage_deals refuses a rep's "team" with 42501, so a rep's Show more and closed lists failed every time.
  const readScope = canTeam ? key.scope : "mine";
  const isFirstKey = key.scope === "team" && key.owner === null;
  const query = useBoard(key, isFirstKey ? first : undefined, extraPages);
  const board = query.data;
  const [now, setNow] = useState(() => query.dataUpdatedAt || Date.now());
  const [wasFetching, setWasFetching] = useState(query.isFetching);
  if (wasFetching !== query.isFetching) {
    // One "now" for the whole board, refreshed when a fetch lands (design 5.5). Not on every cache write: an optimistic
    // move moves dataUpdatedAt too, and a new "now" re-renders every card on the board (day5-perf).
    setWasFetching(query.isFetching);
    if (!query.isFetching) setNow(query.dataUpdatedAt || now);
  }

  const flows = useDealFlows(stepUpSeconds, order);
  const { actions, openWin, openLose, openReopen, reopenFromHistory, openDelete } = flows;
  const [sheetId, setSheetId] = useState<string | null>(initialDeal);
  const [openNew, setOpenNew] = useState(initialNew);
  const [closedList, setClosedList] = useState<"won" | "lost" | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; to: "won" | "lost"; from: SettleFrom | null } | null>(null);
  const [settleFrom, setSettleFrom] = useState<SettleFrom | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  // A card to focus after commit (it may have just moved), or a column's heading when a lost or deleted card left an
  // empty column.
  const [focusRequest, setFocusRequest] = useState<{ id: string; token: number; column?: BoardColumnKey } | null>(null);
  const [shown, setShown] = useState<Partial<Record<BoardColumnKey, number>>>({});
  const [loadingMore, setLoadingMore] = useState<Partial<Record<BoardColumnKey, boolean>>>({});
  const [moreFailed, setMoreFailed] = useState<Partial<Record<BoardColumnKey, boolean>>>({});
  const tokens = useRef(0);
  const boardRef = useRef<HTMLDivElement>(null);
  // Safety net: a focused card that leaves under the keyboard (a colleague's change, a refetch) hands the focus to the
  // card now at its place, or the one before, instead of <body>.
  useKeepFocus(boardRef, board);
  const scrollerRef = useRef<HTMLDivElement>(null);

  // The command menu's "New deal" and "Show stalled deals" while already here (the URL changes, the page stays).
  const params = useSearchParams();
  const wantNew = params.get("new") === "1";
  const wantStalled = params.get("stalled") === "1";
  const wantDeal = params.get("deal");
  const [seenParams, setSeenParams] = useState({ wantNew, wantStalled, wantDeal });
  if (seenParams.wantNew !== wantNew || seenParams.wantStalled !== wantStalled || seenParams.wantDeal !== wantDeal) {
    setSeenParams({ wantNew, wantStalled, wantDeal });
    if (wantNew && !seenParams.wantNew) setOpenNew(true);
    if (wantStalled && !seenParams.wantStalled) setStalledOnly(true);
    if (wantDeal && wantDeal !== seenParams.wantDeal && /^[0-9a-f-]{36}$/i.test(wantDeal)) setSheetId(wantDeal);
  }

  const openSheet = useCallback((id: string | null) => {
    setSheetId(id);
    writeUrl((u) => (id ? u.searchParams.set("deal", id) : u.searchParams.delete("deal")));
  }, []);

  // ---- What the board shows ----------------------------------------------------------------------------------------
  const display = useMemo(() => {
    if (!board) return null;
    return pending?.to === "won" && findCard(board, pending.id)?.column !== "won" ? applyMove(board, pending.id, "won", new Date(now).toISOString()) : board;
  }, [board, pending, now]);
  const columns = useMemo(() => {
    if (!display) return [];
    return boardColumns.map((key) => {
      const summary = key === "won" ? display.won : display.stages.find((s) => s.key === key)!;
      let cards = cardsOf(display, key);
      if (stalledOnly) cards = cards.filter((c) => c.is_stalled);
      cards = sortLoaded(cards, order);
      const limit = phone ? (shown[key] ?? 30) : Infinity;
      const visible = cards.slice(0, limit);
      const stage = key === "won" ? null : display.stages.find((s) => s.key === key)!;
      return {
        key,
        count: summary.count,
        value: summary.value,
        stalled: stage?.stalled ?? 0,
        stallDays: stage?.stall_days ?? null,
        next: (key === "won" ? display.won.next : stage!.next) as Cursor,
        cards: visible,
        hidden: cards.length - visible.length,
      };
    });
  }, [display, stalledOnly, order, phone, shown]);

  const firstCardId = columns.find((c) => c.cards.length)?.cards[0]?.id ?? null;
  const tabStopId = focusId && display && findCard(display, focusId) ? focusId : firstCardId;
  const orgEmpty = !!board && board.open_total.count === 0 && board.won.count === 0 && board.lost.count === 0;
  const stalledTotal = board ? board.stages.reduce((n, s) => n + s.stalled, 0) : 0;
  const filteredEmpty = stalledOnly && columns.every((c) => c.cards.length === 0) && !orgEmpty;

  // ---- Settle after a move (the card is already in its new place) and focus that follows the card -------------------
  useLayoutEffect(() => {
    if (!settleFrom) return;
    settle(settleFrom, reduce);
  }, [settleFrom, reduce]);
  useEffect(() => {
    if (!focusRequest) return;
    const el = focusRequest.id
      ? document.querySelector<HTMLElement>(`[data-deal-main="${CSS.escape(focusRequest.id)}"]`)
      : focusRequest.column
        ? document.querySelector<HTMLElement>(`[data-column-heading="${focusRequest.column}"]`)
        : null;
    if (el) el.focus({ preventScroll: false });
  }, [focusRequest, board]);

  // Where the focus goes when a card leaves the board (lost or deleted, design 7.8: never <body>): the next card in its
  // column, else the one before, else the column's heading. Worked out while the card is still there.
  const latestColumns = useRef(columns);
  useLayoutEffect(() => {
    latestColumns.current = columns;
  }, [columns]);
  const focusAfterLeaving = useCallback((card: DealCard) => {
    const col = latestColumns.current.find((c) => c.cards.some((x) => x.id === card.id));
    if (!col) return { id: "", column: undefined };
    const i = col.cards.findIndex((x) => x.id === card.id);
    const next = col.cards[i + 1] ?? col.cards[i - 1];
    return next ? { id: next.id, column: undefined } : { id: "", column: col.key };
  }, []);

  const settleNext = (id: string, from: { left: number; top: number } | null) => {
    tokens.current += 1;
    if (from) setSettleFrom({ id, left: from.left, top: from.top, token: tokens.current });
  };
  const rectOf = (id: string) => {
    const r = cardElement(id)?.getBoundingClientRect();
    return r ? { left: r.left, top: r.top } : null;
  };

  // ---- Moves from every path ---------------------------------------------------------------------------------------
  const moveCard = useCallback(
    (card: DealCard, to: OpenStageKey, from: { left: number; top: number } | null, keyboard: boolean) => {
      if (card.status !== "open") {
        openReopen(card, to);
        return;
      }
      void actions.move(card, to);
      settleNext(card.id, from);
      if (keyboard) setFocusRequest({ id: card.id, token: tokens.current });
    },
    [actions, openReopen],
  );

  const askWin = useCallback(
    (card: DealCard, from: SettleFrom | null) => {
      if (card.status !== "open") return;
      setPending({ id: card.id, to: "won", from });
      openWin(card, (ok) => {
        setPending(null);
        if (!ok && from) settleNext(card.id, from);
        setFocusRequest({ id: card.id, token: tokens.current + 1 });
      });
    },
    [openWin],
  );
  const askLose = useCallback(
    (card: DealCard, from: SettleFrom | null) => {
      if (card.status !== "open") return;
      const after = focusAfterLeaving(card);
      setPending({ id: card.id, to: "lost", from });
      openLose(card, (ok) => {
        setPending(null);
        if (!ok && from) settleNext(card.id, from);
        // Cancel: back to the card. Lost: the card leaves the board, so its neighbour (or the column) takes the focus.
        setFocusRequest(ok ? { ...after, token: tokens.current + 1 } : { id: card.id, token: tokens.current + 1 });
      });
    },
    [openLose, focusAfterLeaving],
  );
  // Delete: the card stays until the database answers; then its neighbour (or the column) takes the focus.
  const askDelete = useCallback(
    (card: DealCard) => {
      const after = focusAfterLeaving(card);
      openDelete(card, (ok) => setFocusRequest(ok ? { ...after, token: tokens.current + 1 } : { id: card.id, token: tokens.current + 1 }));
    },
    [openDelete, focusAfterLeaving],
  );

  const menuFor = useCallback(
    (card: DealCard): DealMenuActions => {
      const last = lastUndoableMove();
      return {
        move: (to) => moveCard(card, to, rectOf(card.id), true),
        win: () => askWin(card, null),
        lose: () => askLose(card, null),
        // Reopen goes back to the stage the deal was closed from (design 7.6); focus follows the card.
        reopen: () => void reopenFromHistory(card, () => setFocusRequest({ id: card.id, token: tokens.current + 1 })),
        editValue: () => {
          openSheet(card.id);
          requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-deal-value]")?.focus()));
        },
        openLead: () => router.push(`/leads/${card.company_id}`),
        copyLink: () => void navigator.clipboard?.writeText(`${window.location.origin}/pipeline?deal=${card.id}`),
        undo: last && last.id === card.id ? () => void actions.undo(last) : null,
        remove: () => askDelete(card),
      };
    },
    [moveCard, askWin, askLose, reopenFromHistory, openSheet, router, actions, askDelete],
  );

  const handlers = useMemo<BoardHandlers>(
    () => ({
      onFocusCard: (id) => setFocusId(id),
      onNext: (card) => {
        if (card.stage === "negotiations") askWin(card, null);
        else if (card.stage === "lead") moveCard(card, "qualified", rectOf(card.id), false);
        else if (card.stage === "qualified") moveCard(card, "negotiations", rectOf(card.id), false);
      },
      menu: menuFor,
      live: (card) => {
        const latest = qc.getQueryData<Board>(boardKey(key.scope, key.owner));
        return (latest && findCard(latest, card.id)?.card) || card;
      },
      onKey: (card, action) => {
        switch (action.kind) {
          case "move":
            if (!card.can_edit) return;
            if (action.to === "won") return askWin(card, null);
            if (action.to === "lost") return askLose(card, null);
            if (card.stage === action.to) return;
            return moveCard(card, action.to, rectOf(card.id), true);
          case "open":
            return openSheet(card.id);
          case "editValue":
            return menuFor(card).editValue();
          case "openLead":
            return router.push(`/leads/${card.company_id}`);
          case "undo":
            return void actions.undo();
          case "delete":
            return card.can_delete ? askDelete(card) : undefined;
          default:
            return;
        }
      },
    }),
    [menuFor, askWin, askLose, moveCard, openSheet, router, actions, askDelete, qc, key],
  );
  // The cards read one handlers object that never changes (each call goes to this render's handlers), so a move, a
  // focus change or a drag over a column does not re-render every memoised card through the context (day5-perf).
  const latestHandlers = useRef(handlers);
  useLayoutEffect(() => {
    latestHandlers.current = handlers;
  }, [handlers]);
  const stableHandlers = useMemo<BoardHandlers>(
    () => ({
      onFocusCard: (id) => latestHandlers.current.onFocusCard(id),
      onNext: (card) => latestHandlers.current.onNext(card),
      menu: (card) => latestHandlers.current.menu(card),
      live: (card) => latestHandlers.current.live(card),
      onKey: (card, action) => latestHandlers.current.onKey(card, action),
    }),
    [],
  );

  // ---- Page keys: N new deal; U and Cmd/Ctrl+Z undo the last move (before the call panel's own Undo key) -------------
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const action = pageKeyAction(e, { typing: isTyping(e.target), dialogOpen: !!document.querySelector("[role=dialog]"), chordPending: shell.isChordPending() });
      if (action === "new") {
        e.preventDefault();
        setOpenNew(true);
      } else if (action === "undo" && lastUndoableMove()) {
        e.preventDefault();
        void actions.undo();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [shell, actions]);

  // ---- Roving focus: one tab stop into the board; ↑/↓, Home/End in a column; ←/→ to the nearest card next door ------
  const onBoardKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (activeId || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const target = e.target as HTMLElement;
    const id = target.getAttribute("data-deal-main");
    if (!id) return;
    const cols = [...(boardRef.current?.querySelectorAll<HTMLElement>("[data-column]") ?? [])];
    const colEl = target.closest<HTMLElement>("[data-column]");
    const ci = colEl ? cols.indexOf(colEl) : -1;
    if (ci < 0) return;
    const cardsIn = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>("[data-deal-main]")];
    const here = cardsIn(cols[ci]);
    const i = here.indexOf(target);
    let next: HTMLElement | undefined;
    if (e.key === "ArrowDown") next = here[i + 1];
    else if (e.key === "ArrowUp") next = here[i - 1];
    else if (e.key === "Home") next = here[0];
    else if (e.key === "End") next = here[here.length - 1];
    else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const step = e.key === "ArrowRight" ? 1 : -1;
      for (let c = ci + step; c >= 0 && c < cols.length && !next; c += step) {
        const there = cardsIn(cols[c]);
        if (!there.length) continue;
        const y = target.getBoundingClientRect().top;
        next = there.reduce((best, el) => (Math.abs(el.getBoundingClientRect().top - y) < Math.abs(best.getBoundingClientRect().top - y) ? el : best), there[0]);
      }
    } else return;
    if (!next) return;
    e.preventDefault();
    next.focus();
    next.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  // ---- Drag ----------------------------------------------------------------------------------------------------------
  const columnJump = useMemo(() => makeColumnJump(() => window.matchMedia(phoneQuery).matches), []);
  // The sensor options keep their identity across renders: dnd-kit rebuilds its context when a sensor's options object
  // changes, and that re-renders every draggable card on each board render (day5-perf).
  const keyboardOptions = useMemo(() => ({ coordinateGetter: columnJump, keyboardCodes: KEYBOARD_CODES }), [columnJump]);
  const sensors = useSensors(useSensor(MouseSensor, MOUSE_OPTIONS), useSensor(TouchSensor, TOUCH_OPTIONS), useSensor(KeyboardSensor, keyboardOptions));
  const facts = useCallback(
    (id: string) => {
      const c = board ? findCard(board, id)?.card : null;
      return c ? { lead: c.company_name, value: c.value ? formatMoney(c.value, locale) : tAnn("noValue"), stage: tStage(c.stage) } : null;
    },
    [board, locale, tAnn, tStage],
  );
  const announcements = useMemo(() => buildAnnouncements((k, v) => tAnn(k as "start", v), facts, (id) => tStage(id as "lead")), [tAnn, facts, tStage]);
  const instructions = useMemo(() => buildInstructions((k) => tAnn(k as "instructions")), [tAnn]);
  const activeCard = activeId && board ? (findCard(board, activeId)?.card ?? null) : null;

  const onDragStart = (e: DragStartEvent) => {
    setActiveId(String(e.active.id));
    if (navigator.vibrate && navigator.userActivation?.hasBeenActive) navigator.vibrate(8);
  };
  const onDragOver = (e: DragOverEvent) => setOverId(e.over ? String(e.over.id) : null);
  const onDragEnd = (e: DragEndEvent) => {
    const id = String(e.active.id);
    const r = e.active.rect.current.translated;
    const from = r ? { id, left: r.left, top: r.top, token: 0 } : null;
    setActiveId(null);
    setOverId(null);
    const card = board ? findCard(board, id)?.card : null;
    const to = e.over ? String(e.over.id) : null;
    if (!card || !to || to === card.stage) {
      if (from) settleNext(id, from);
      return;
    }
    if (to === "won") return askWin(card, from);
    if (to === "lost") return askLose(card, from);
    moveCard(card, to as OpenStageKey, from, e.activatorEvent instanceof KeyboardEvent);
  };
  const onDragCancel = () => {
    const id = activeId;
    setActiveId(null);
    setOverId(null);
    if (id) setFocusRequest({ id, token: tokens.current + 1 });
  };

  // ---- Show more (keyset pages; "Stalled only" asks for stalled pages) ---------------------------------------------
  const showMore = async (col: (typeof columns)[number]) => {
    if (phone && col.hidden > 0) {
      setShown((s) => ({ ...s, [col.key]: (s[col.key] ?? 30) + 30 }));
      return;
    }
    const all = board ? cardsOf(board, col.key) : [];
    const last = stalledOnly ? all.filter((c) => c.is_stalled).at(-1) : all.at(-1);
    const cursor = stalledOnly ? (last ? { after_at: col.key === "won" ? last.closed_at! : last.stage_entered_at, after_id: last.id } : null) : col.next;
    if (!cursor && !stalledOnly) return;
    setLoadingMore((s) => ({ ...s, [col.key]: true }));
    setMoreFailed((s) => ({ ...s, [col.key]: false }));
    try {
      const p = new URLSearchParams({ stage: col.key, scope: readScope });
      if (key.owner) p.set("owner", key.owner);
      if (stalledOnly) p.set("stalled", "1");
      if (cursor) {
        p.set("after_at", cursor.after_at);
        p.set("after_id", cursor.after_id);
      }
      const res = await fetch(`/api/pipeline/stage?${p}`, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(String(res.status));
      const page = (await res.json()) as { cards: DealCard[]; next: Cursor };
      qc.setQueryData<Board>(boardKey(key.scope, key.owner), (old) => (old ? appendPage(old, col.key, page.cards, stalledOnly ? col.next : page.next) : old));
      setExtraPages(true);
      if (phone) setShown((s) => ({ ...s, [col.key]: (s[col.key] ?? 30) + BOARD_PAGE }));
    } catch {
      setMoreFailed((s) => ({ ...s, [col.key]: true }));
    } finally {
      setLoadingMore((s) => ({ ...s, [col.key]: false }));
    }
  };

  // ---- Phone stage tabs synced with the column in view ---------------------------------------------------------------
  const [inView, setInView] = useState<BoardColumnKey>("lead");
  useEffect(() => {
    const root = scrollerRef.current;
    if (!root || !phone) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) if (en.isIntersecting && en.intersectionRatio > 0.6) setInView(en.target.getAttribute("data-column") as BoardColumnKey);
      },
      { root, threshold: [0.6] },
    );
    root.querySelectorAll("[data-column]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [phone, columns.length]);
  const scrollToColumn = (key: BoardColumnKey) => {
    scrollerRef.current?.querySelector(`[data-column="${key}"]`)?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", inline: "start", block: "nearest" });
    setInView(key);
  };

  if (!board || !display) return null;
  const dragging = !!activeId;
  const status = !online ? (
    <span role="status">{t("offline")}</span>
  ) : query.isRefetchError ? (
    <span role="status" className="inline-flex items-center gap-2">
      {t("refreshFailed")}
      <Button variant="link" className="min-h-11 text-sm sm:min-h-9" onClick={() => void query.refetch()}>
        {t("retry")}
      </Button>
    </span>
  ) : null;

  return (
    <BoardHandlersContext.Provider value={stableHandlers}>
      {/* From tablet width the page fills the screen down to 118 px above its bottom (clear of the dock; the 72 px top bar
          above it) and the columns take what the toolbar leaves, in CSS alone. The server's HTML has the final column
          height: a height measured after hydration moved a column under a pointer pressed during hydration, so the tap
          on Show more was lost (PR #17 CI). */}
      <div className="flex min-w-0 flex-col gap-5 pt-2 md:min-h-[calc(100dvh-190px)]">
        <BoardToolbar
          total={board.open_total}
          canTeam={canTeam}
          scope={scope}
          onScope={(s) => {
            setScope(s);
            setExtraPages(false);
          }}
          owner={owner}
          onOwner={(o) => {
            setOwner(o);
            setExtraPages(false);
          }}
          team={team}
          stalledOnly={stalledOnly}
          stalledCount={stalledTotal}
          onStalled={(on) => {
            setStalledOnly(on);
            writeUrl((u) => (on ? u.searchParams.set("stalled", "1") : u.searchParams.delete("stalled")));
          }}
          order={order}
          onOrder={setOrder}
          onNewDeal={() => setOpenNew(true)}
          status={status}
        />

        {orgEmpty && isFirstKey ? (
          <div className="flex flex-col items-start gap-3 rounded-lg bg-card p-5">
            <p className="max-w-[65ch] text-sm">{t("empty.org")}</p>
            <div className="flex flex-wrap gap-2">
              <Link href="/leads" className="inline-flex min-h-11 items-center rounded-md bg-muted px-4 text-sm font-bold transition-transform duration-150 active:scale-[0.97]">
                {t("empty.orgLeads")}
              </Link>
            </div>
          </div>
        ) : null}
        {!isFirstKey && board.open_total.count === 0 && board.won.count === 0 && canTeam && scope === "mine" ? (
          <p className="flex flex-wrap items-center gap-2 text-sm">
            {t("empty.mine")}
            <Button variant="link" className="min-h-11 text-sm sm:min-h-9" onClick={() => setScope("team")}>
              {t("empty.showTeam")}
            </Button>
          </p>
        ) : null}
        {filteredEmpty ? (
          <p className="flex flex-wrap items-center gap-2 text-sm">
            {t("empty.filtered")}
            <Button variant="link" className="min-h-11 text-sm sm:min-h-9" onClick={() => setStalledOnly(false)}>
              {t("empty.clear")}
            </Button>
          </p>
        ) : null}

        {phone ? (
          <nav aria-label={t("stageTabs")} className="sticky top-0 z-[5] -mx-4 bg-background/95 px-4 py-2 backdrop-blur-sm">
            <div className="edge-fade flex gap-1 overflow-x-auto">
              {columns.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  aria-current={inView === c.key ? "true" : undefined}
                  onClick={() => scrollToColumn(c.key)}
                  className="relative min-h-11 shrink-0 rounded-md px-3 text-sm whitespace-nowrap"
                >
                  {inView === c.key ? (
                    <motion.span layoutId="stage-tab-pill" transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 300, damping: 30 }} className="absolute inset-0 rounded-md bg-card" />
                  ) : null}
                  <span className="relative">
                    {tStage(`short.${c.key}`)} <span className="font-mono text-xs tabular-nums text-muted-foreground">{format.number(c.count)}</span>
                  </span>
                </button>
              ))}
            </div>
          </nav>
        ) : null}

        <DndContext
          id="pipeline-board"
          sensors={online ? sensors : NO_SENSORS}
          collisionDetection={pointerFirst}
          measuring={MEASURING}
          autoScroll={AUTO_SCROLL}
          accessibility={{ announcements, screenReaderInstructions: instructions }}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={onDragCancel}
        >
          <div
            ref={boardRef}
            role="region"
            aria-label={t("boardLabel")}
            data-dragging={dragging || undefined}
            onKeyDown={onBoardKeyDown}
            className="min-w-0 md:flex md:grow md:basis-0 md:flex-col"
          >
            <div
              ref={scrollerRef}
              className={cn(
                "-mx-4 flex gap-3 overflow-x-auto overscroll-x-contain px-4 pb-2 sm:-mx-8 sm:px-8 md:min-h-min md:grow md:basis-0 lg:mx-0 lg:grid lg:grid-cols-[repeat(4,minmax(220px,1fr))] lg:gap-3 lg:overflow-visible lg:px-0 xl:gap-4",
                dragging ? "snap-none select-none" : "snap-x snap-mandatory lg:snap-none",
              )}
            >
              {columns.map((c) => (
                <Column
                  key={c.key}
                  column={c.key}
                  title={c.key === "won" ? `${tStage("won")} · ${tStage("wonWindow")}` : tStage(c.key)}
                  count={c.count}
                  value={c.value}
                  stalled={c.stalled}
                  cards={c.cards}
                  hiddenCount={c.hidden}
                  canShowMore={!!c.next || (stalledOnly && c.stalled > c.cards.length)}
                  loadingMore={!!loadingMore[c.key]}
                  loadMoreFailed={!!moreFailed[c.key]}
                  onShowMore={() => void showMore(c)}
                  showOwner={key.scope === "team" && key.owner === null && canTeam}
                  now={now}
                  stallDays={c.stallDays}
                  tabStopId={tabStopId}
                  dimId={pending?.id ?? null}
                  activeId={activeId}
                  over={overId === c.key}
                  dragging={dragging}
                  phone={phone}
                  emptyText={c.key === "lead" ? t("empty.lead") : t("empty.column", { stage: tStage(c.key) })}
                  footer={
                    c.key === "won" && board.won.count > 0 ? (
                      <Button variant="link" className="mt-1 min-h-11 w-full text-xs sm:min-h-9" onClick={() => setClosedList("won")}>
                        {t("seeWon")}
                      </Button>
                    ) : null
                  }
                />
              ))}
            </div>
            <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              <span>{t("lostLine", { count: format.number(board.lost.count) })}</span>
              {board.lost.reasons.map((r) => (
                <span key={r.code}>
                  <span aria-hidden="true">· </span>
                  {t("lostReason", { reason: tReason(r.code), count: format.number(r.count) })}
                </span>
              ))}
              {/* On phones the link takes its own line, so no separator is left hanging at a line's end (Day 7c). */}
              <span aria-hidden="true" className="max-sm:hidden">
                ·
              </span>
              <Button variant="link" className="min-h-11 text-sm max-sm:basis-full max-sm:justify-start sm:min-h-0" onClick={() => setClosedList("lost")}>
                {t("seeLost")}
              </Button>
            </p>
          </div>
          <AnimatePresence>{dragging ? <LostBand key="lost-band" /> : null}</AnimatePresence>
          <DragOverlay dropAnimation={null}>{activeCard ? <DealCardGhost card={activeCard} /> : null}</DragOverlay>
        </DndContext>

        {pending ? (
          <p className="sr-only" role="status">
            {pending.to === "won" ? t("confirmWin") : null}
          </p>
        ) : null}
      </div>

      <DealSheet
        dealId={sheetId}
        onClose={() => {
          const id = sheetId;
          openSheet(null);
          if (id) setFocusRequest({ id, token: tokens.current + 1 });
        }}
        flows={flows}
        team={team}
        canAssign={canTeam}
      />
      <OpenDealSheet
        open={openNew}
        initialLead={null}
        onClose={() => {
          setOpenNew(false);
          writeUrl((u) => u.searchParams.delete("new"));
        }}
        onOpened={(id) => {
          setOpenNew(false);
          writeUrl((u) => u.searchParams.delete("new"));
          setFocusRequest({ id, token: tokens.current + 1 });
        }}
        onOpenExisting={(id) => {
          setOpenNew(false);
          openSheet(id);
        }}
        actions={actions}
        team={team}
        canAssign={canTeam}
        meId={me.id}
      />
      <ClosedDealsDialog
        kind={closedList}
        scope={readScope}
        owner={key.owner}
        onClose={() => setClosedList(null)}
        onOpenDeal={(id) => {
          setClosedList(null);
          openSheet(id);
        }}
      />
      {flows.dialogs}
    </BoardHandlersContext.Provider>
  );
}
