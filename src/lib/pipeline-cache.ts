import { addMoney, subMoney, toCents } from "@/lib/money";
import type { Board, BoardColumnKey, DealCard, LostReason, SortOrder, StageKey } from "@/lib/deals";

// The board in the query cache, changed by pure functions (Day 5 design 7.5): a move shows at once (optimistic), a
// failure puts that card back where the snapshot taken before had it (other cards keep what landed meanwhile), and a
// server answer replaces the card where it really is. Nothing here touches the network.

/** The column a card sits in on the board (Lost is not a column: its cards leave the board). */
export function columnOf(stage: StageKey): BoardColumnKey | null {
  return stage === "lost" ? null : stage;
}

/** Where a card is now: the column and its index, or null when it is not loaded. */
export function findCard(board: Board, id: string): { column: BoardColumnKey; index: number; card: DealCard } | null {
  for (const col of board.stages) {
    const index = col.cards.findIndex((c) => c.id === id);
    if (index >= 0) return { column: col.key, index, card: col.cards[index] };
  }
  const index = board.won.cards.findIndex((c) => c.id === id);
  return index >= 0 ? { column: "won", index, card: board.won.cards[index] } : null;
}

export function cardsOf(board: Board, column: BoardColumnKey): DealCard[] {
  return column === "won" ? board.won.cards : (board.stages.find((s) => s.key === column)?.cards ?? []);
}

/** The board without one card, with that column's counts and totals (and the open total) fixed. */
export function removeCard(board: Board, id: string): Board {
  const at = findCard(board, id);
  if (!at) return board;
  const { card } = at;
  if (at.column === "won") {
    return {
      ...board,
      won: { ...board.won, count: Math.max(0, board.won.count - 1), value: subMoney(board.won.value, card.value), cards: board.won.cards.filter((c) => c.id !== id) },
    };
  }
  return {
    ...board,
    stages: board.stages.map((s) =>
      s.key !== at.column
        ? s
        : {
            ...s,
            count: Math.max(0, s.count - 1),
            value: subMoney(s.value, card.value),
            no_value: Math.max(0, s.no_value - (card.value === null ? 1 : 0)),
            stalled: Math.max(0, s.stalled - (card.is_stalled ? 1 : 0)),
            cards: s.cards.filter((c) => c.id !== id),
          },
    ),
    open_total: { count: Math.max(0, board.open_total.count - 1), value: subMoney(board.open_total.value, card.value) },
  };
}

/** Where a card goes in a column's loaded cards: newest in stage first ("Recently moved"), or last ("Longest in stage"). */
function insertAt(cards: DealCard[], card: DealCard, order: SortOrder): DealCard[] {
  const rest = cards.filter((c) => c.id !== card.id);
  return order === "oldest" ? [...rest, card] : [card, ...rest];
}

/** The board with one card added to the column its stage names (a lost card only counts in the Lost line). */
export function addCard(board: Board, card: DealCard, order: SortOrder = "recent"): Board {
  if (card.stage === "lost") {
    const code = card.lost_reason;
    const reasons = code
      ? board.lost.reasons.some((r) => r.code === code)
        ? board.lost.reasons.map((r) => (r.code === code ? { ...r, count: r.count + 1 } : r))
        : [...board.lost.reasons, { code: code as LostReason, count: 1 }]
      : board.lost.reasons;
    return { ...board, lost: { count: board.lost.count + 1, reasons: [...reasons].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)) } };
  }
  if (card.stage === "won") {
    return { ...board, won: { ...board.won, count: board.won.count + 1, value: addMoney(board.won.value, card.value), cards: insertAt(board.won.cards, card, "recent") } };
  }
  return {
    ...board,
    stages: board.stages.map((s) =>
      s.key !== card.stage
        ? s
        : {
            ...s,
            count: s.count + 1,
            value: addMoney(s.value, card.value),
            no_value: s.no_value + (card.value === null ? 1 : 0),
            stalled: s.stalled + (card.is_stalled ? 1 : 0),
            cards: insertAt(s.cards, card, order),
          },
    ),
    open_total: { count: board.open_total.count + 1, value: addMoney(board.open_total.value, card.value) },
  };
}

/** A lost card leaving the Lost line again (an Undo of a loss, a reopen): the count and its reason go down. */
function unlose(board: Board, reason: LostReason | null): Board {
  return {
    ...board,
    lost: {
      count: Math.max(0, board.lost.count - 1),
      reasons: board.lost.reasons.map((r) => (r.code === reason ? { ...r, count: Math.max(0, r.count - 1) } : r)).filter((r) => r.count > 0),
    },
  };
}

/**
 * The optimistic move (design 7.5): the card leaves its column and enters the target at its sorted place, with its
 * stage clock restarted (0 days, not stalled: always true right after a move), both columns' counts and totals fixed.
 * A win carries its value and shipping, a loss its reason. Cursors are kept.
 */
export function applyMove(
  board: Board,
  id: string,
  to: StageKey,
  nowIso: string,
  patch: Partial<Pick<DealCard, "value" | "fulfilment" | "lost_reason">> = {},
  order: SortOrder = "recent",
): Board {
  const at = findCard(board, id);
  if (!at) return board;
  const moved: DealCard = {
    ...at.card,
    ...patch,
    stage: to,
    status: to === "won" ? "won" : to === "lost" ? "lost" : "open",
    stage_entered_at: nowIso,
    closed_at: to === "won" || to === "lost" ? nowIso : null,
    is_stalled: false,
    quiet_days: to === "won" || to === "lost" ? null : 0,
  };
  return addCard(removeCard(board, id), moved, order);
}

/**
 * The server's card replaces the cached one wherever each is (a move's answer, a conflict's "where it really is", an
 * undo's restored clock). A card the board does not show (another owner in Mine, a lost deal) leaves it.
 */
export function replaceCard(board: Board, card: DealCard | null, id: string, order: SortOrder = "recent"): Board {
  const at = findCard(board, id);
  if (!card) return at ? removeCard(board, id) : board;
  if (at && at.column === card.stage && at.card.version === card.version && at.card.value === card.value && at.card.is_stalled === card.is_stalled) {
    // Same place and numbers: swap the object only (keeps its position).
    const swap = (cards: DealCard[]) => cards.map((c) => (c.id === id ? card : c));
    return at.column === "won"
      ? { ...board, won: { ...board.won, cards: swap(board.won.cards) } }
      : { ...board, stages: board.stages.map((s) => (s.key === at.column ? { ...s, cards: swap(s.cards) } : s)) };
  }
  let next = at ? removeCard(board, id) : board;
  if (!at && card.stage === "lost") return next; // already counted where it was
  next = addCard(next, card, order);
  return next;
}

/**
 * A failed change rolled back for its own card only: the card goes back to the column and place it had in `before` (the
 * board when the change started), with both columns' counts and totals; every other card stays as the board has it now,
 * so another deal's move made in between is kept (bugs audit M5: a whole-board snapshot put it back in its old column
 * until its own answer came). `lostReason`: the failed change was a loss with this reason (the card left the board for the Lost line).
 */
export function rollbackCard(board: Board, before: Board, id: string, lostReason?: LostReason): Board {
  const was = findCard(before, id);
  if (!was) return board; // the change never showed on this board
  const next = addCard(findCard(board, id) ? removeCard(board, id) : lostReason ? unlose(board, lostReason) : board, was.card);
  const place = (cards: DealCard[]) => {
    const rest = cards.filter((c) => c.id !== id);
    return [...rest.slice(0, was.index), was.card, ...rest.slice(was.index)];
  };
  return was.column === "won"
    ? { ...next, won: { ...next.won, cards: place(next.won.cards) } }
    : { ...next, stages: next.stages.map((s) => (s.key === was.column ? { ...s, cards: place(s.cards) } : s)) };
}

/** An Undo that brings a lost card back (the board did not hold it): the Lost line goes down, the card comes back. */
export function restoreFromLost(board: Board, card: DealCard, reason: LostReason | null, order: SortOrder = "recent"): Board {
  return addCard(unlose(board, reason), card, order);
}

/** The next page of a column (keyset), without repeating a card already loaded. */
export function appendPage(board: Board, column: BoardColumnKey, cards: DealCard[], next: Board["won"]["next"]): Board {
  const add = (have: DealCard[]) => {
    const ids = new Set(have.map((c) => c.id));
    return [...have, ...cards.filter((c) => !ids.has(c.id))];
  };
  if (column === "won") return { ...board, won: { ...board.won, cards: add(board.won.cards), next } };
  return { ...board, stages: board.stages.map((s) => (s.key === column ? { ...s, cards: add(s.cards), next } : s)) };
}

/**
 * Loaded cards in the chosen order. "Recently moved" and "Longest in stage" are the server's keyset order; "Value" and
 * "Close date" re-sort the loaded cards only (design D20: numeric is not leakproof, so value is never a keyset), with a
 * note on screen when more exist. Ties keep the server order.
 */
export function sortLoaded(cards: DealCard[], order: SortOrder): DealCard[] {
  if (order === "recent" || order === "oldest") return cards;
  const indexed = cards.map((c, i) => ({ c, i }));
  indexed.sort((a, b) => {
    if (order === "value") {
      const av = a.c.value === null ? null : toCents(a.c.value);
      const bv = b.c.value === null ? null : toCents(b.c.value);
      if (av === null || bv === null) return av === bv ? a.i - b.i : av === null ? 1 : -1;
      return av === bv ? a.i - b.i : av > bv ? -1 : 1;
    }
    const ac = a.c.expected_close;
    const bc = b.c.expected_close;
    if (ac === null || bc === null) return ac === bc ? a.i - b.i : ac === null ? 1 : -1;
    return ac === bc ? a.i - b.i : ac < bc ? -1 : 1;
  });
  return indexed.map((x) => x.c);
}

/** Only the stalled cards (the "Stalled only" chip filters loaded cards too while its pages load). */
export function stalledOnly(board: Board): Board {
  return {
    ...board,
    stages: board.stages.map((s) => ({ ...s, cards: s.cards.filter((c) => c.is_stalled) })),
  };
}
