"use client";

import { useCallback, useMemo } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { MutationObserver, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  deleteDeal,
  loseDeal,
  moveDeal,
  openDeal,
  reopenDeal,
  undoDealMove,
  updateDeal,
  winDeal,
} from "@/app/(app)/pipeline/actions";
import { useToast } from "@/components/ui/toast";
import { leadKey } from "@/components/leads/use-leads";
import type { ActionFailure, ActionResult } from "@/lib/db-errors";
import {
  DEAL_TOAST_SECONDS,
  type Board,
  type BoardOrder,
  type DealCard,
  type DealDetail,
  type Fulfilment,
  type LostReason,
  type MoveResult,
  type OpenResult,
  type OpenStageKey,
  type SortOrder,
  type StageKey,
  type UpdateField,
  type UpdateResult,
} from "@/lib/deals";
import { formatMoney } from "@/lib/money";
import { applyMove, findCard, removeCard, replaceCard, restoreFromLost } from "@/lib/pipeline-cache";
import { boardKey, dealKey, fetchBoardClient, leadDealsKey } from "@/lib/prefetch";
import { clearLastMove, lastUndoableMove, setLastMove, type LastMove } from "@/lib/last-move";

// The pipeline's data and writes (Day 5 design 7.5). The board lives in the query cache under boardKey(scope, owner, order):
// seeded from the server's promise, refetched on focus and every 30 s while the tab is visible. Every stage change is a
// MutationObserver with scope "deal-<id>" (spike S12: TanStack runs one scope's mutations in series, other deals in
// parallel), so quick keys on one card queue up; each mutationFn reads the deal's latest version when it runs. The move
// shows at once (applyMove); a failure puts the snapshot back and drops the moves queued behind it on that deal (TanStack
// does not cancel them: S12); a conflict (a result, D5) puts the card where it really is and says who moved it.

export type ScopeOwner = { scope: "team" | "mine"; owner: string | null; order: BoardOrder };

export function useBoard(key: ScopeOwner, initial: Board | undefined, extraPages: boolean) {
  return useQuery({
    queryKey: boardKey(key.scope, key.owner, key.order),
    queryFn: () => fetchBoardClient(key.scope, key.owner, key.order),
    initialData: initial,
    // The server's first paint is fresh for the usual 30 s; then focus and the 30 s timer refresh it. Once "Show more"
    // pages are loaded, the timer stops (a refetch would drop them); focus still refreshes.
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    refetchInterval: extraPages ? false : 30_000,
  });
}

// ---- Per-deal bookkeeping (module level: one tab, one cache) -------------------------------------------------------
/** The deal's latest version from the server (a move's answer); read by each queued mutationFn when it runs. */
const versions = new Map<string, number>();
/** Moves started but not settled, per deal. */
const pending = new Map<string, number>();
/** Bumped by a failure or a conflict: queued moves started before it drop out instead of running. */
const generation = new Map<string, number>();

// The last move this tab made lives in src/lib/last-move.ts (read by the app-wide call panel too).
export { lastUndoableMove, type LastMove };

class Superseded extends Error {}

type Change =
  | { kind: "move"; to: OpenStageKey }
  | { kind: "reopen"; to: OpenStageKey }
  | { kind: "win"; value: string; fulfilment: Fulfilment }
  | { kind: "lose"; reason: LostReason; note: string | null };

function targetOf(change: Change): StageKey {
  return change.kind === "win" ? "won" : change.kind === "lose" ? "lost" : change.to;
}

type Snapshot = { board: [readonly unknown[], Board | undefined][]; deal: DealDetail | null | undefined; leadDeals: DealCard[] | undefined };

function snapshot(qc: QueryClient, card: DealCard): Snapshot {
  return {
    board: qc.getQueriesData<Board>({ queryKey: ["pipeline", "board"] }),
    deal: qc.getQueryData<DealDetail | null>(dealKey(card.id)),
    leadDeals: qc.getQueryData<DealCard[]>(leadDealsKey(card.company_id)),
  };
}

function restore(qc: QueryClient, card: DealCard, snap: Snapshot) {
  for (const [key, data] of snap.board) qc.setQueryData(key, data);
  qc.setQueryData(dealKey(card.id), snap.deal);
  qc.setQueryData(leadDealsKey(card.company_id), snap.leadDeals);
}

/** The server's card everywhere the deal shows (every board key, the deal sheet, the lead's Deals tab). */
function writeCard(qc: QueryClient, id: string, card: DealCard | null, order: SortOrder, keepStage: boolean) {
  for (const [key, board] of qc.getQueriesData<Board>({ queryKey: ["pipeline", "board"] })) {
    if (!board) continue;
    if (keepStage && card) {
      // Another move on this deal is queued: keep the optimistic place, take the version and numbers.
      const at = findCard(board, id);
      if (at) {
        const patch = (cards: DealCard[]) => cards.map((c) => (c.id === id ? { ...c, version: card.version } : c));
        qc.setQueryData<Board>(key, at.column === "won" ? { ...board, won: { ...board.won, cards: patch(board.won.cards) } } : { ...board, stages: board.stages.map((s) => (s.key === at.column ? { ...s, cards: patch(s.cards) } : s)) });
      }
      continue;
    }
    qc.setQueryData<Board>(key, replaceCard(board, card, id, order));
  }
  if (card) {
    qc.setQueryData<DealDetail | null>(dealKey(id), (old) => (old ? { ...old, ...card } : old));
    qc.setQueryData<DealCard[]>(leadDealsKey(card.company_id), (old) => (old ? old.map((c) => (c.id === id ? card : c)) : old));
  }
}

function optimistic(qc: QueryClient, card: DealCard, to: StageKey, patch: Partial<DealCard>, order: SortOrder) {
  const now = new Date().toISOString();
  for (const [key, board] of qc.getQueriesData<Board>({ queryKey: ["pipeline", "board"] })) {
    if (board && findCard(board, card.id)) qc.setQueryData<Board>(key, applyMove(board, card.id, to, now, patch, order));
  }
  const moved: Partial<DealCard> = {
    ...patch,
    stage: to,
    status: to === "won" ? "won" : to === "lost" ? "lost" : "open",
    stage_entered_at: now,
    closed_at: to === "won" || to === "lost" ? now : null,
    is_stalled: false,
    quiet_days: to === "won" || to === "lost" ? null : 0,
  };
  qc.setQueryData<DealDetail | null>(dealKey(card.id), (old) => (old ? { ...old, ...moved } : old));
  qc.setQueryData<DealCard[]>(leadDealsKey(card.company_id), (old) => (old ? old.map((c) => (c.id === card.id ? { ...c, ...moved } : c)) : old));
}

/** Whether every board in the cache that holds the deal shows it in `to` already (the optimistic write survived). */
function placedIn(qc: QueryClient, id: string, to: StageKey): boolean {
  return qc.getQueriesData<Board>({ queryKey: ["pipeline", "board"] }).every(([, board]) => {
    const at = board ? findCard(board, id) : null;
    return !at || at.column === to;
  });
}

function refreshAround(qc: QueryClient, card: Pick<DealCard, "id" | "company_id">) {
  void qc.invalidateQueries({ queryKey: ["home"] });
  void qc.invalidateQueries({ queryKey: ["pipeline", "summary"] });
  void qc.invalidateQueries({ queryKey: leadKey(card.company_id) });
  void qc.invalidateQueries({ queryKey: leadDealsKey(card.company_id) });
  void qc.invalidateQueries({ queryKey: dealKey(card.id) });
}

function unwrap<T>(r: ActionResult<T>): T {
  if (!r.ok) throw r;
  return r.data;
}
const isFailure = (e: unknown): e is ActionFailure => typeof e === "object" && e !== null && (e as ActionFailure).ok === false;

/** The pipeline's writes, shared by the board, the deal sheet, the lead's Deals tab and the dialogs. */
export function useDealActions(opts: { order?: SortOrder; stepUp?: { requireFresh: () => Promise<boolean> } } = {}) {
  const qc = useQueryClient();
  const toast = useToast();
  const t = useTranslations("Deals");
  const tPipe = useTranslations("Pipeline");
  const tStage = useTranslations("Stages");
  const tReason = useTranslations("LostReasons");
  const tErr = useTranslations("Errors");
  const locale = useLocale();
  const format = useFormatter();
  const order = opts.order ?? "recent";
  const stepUp = opts.stepUp;

  const errorText = useCallback(
    (e: ActionFailure) => (e.error === "invalid" && e.hint ? tErr(`hint.${e.hint}`) : tErr(e.error)),
    [tErr],
  );

  const showUndoToast = useCallback(
    (message: string, undo: (() => void) | null) => {
      toast.show(message, undo ? { label: tPipe("undo"), run: undo } : undefined, { duration: DEAL_TOAST_SECONDS * 1000 });
    },
    [toast, tPipe],
  );

  // ---- Undo (design 5.3): the same move_deal path as a drag back, with p_undo_of so a stale Undo is refused. --------
  const undo = useCallback(
    async (target: LastMove | null = lastUndoableMove()): Promise<boolean> => {
      if (!target) {
        toast.show(tPipe("undoExpired"));
        return false;
      }
      let res: ActionResult<MoveResult>;
      try {
        res = await undoDealMove({
          id: target.id,
          historyId: target.historyId,
          toStage: target.fromStage,
          version: versions.get(target.id) ?? target.version,
          requestId: crypto.randomUUID(),
        });
      } catch {
        res = { ok: false, error: "unavailable" };
      }
      clearLastMove((m) => m.historyId === target.historyId);
      if (!res.ok) {
        toast.show(res.error === "expired" ? tPipe("undoExpired") : errorText(res));
        return false;
      }
      const r = res.data;
      if (r.result === "conflict") {
        if (r.deal) versions.set(target.id, r.deal.version);
        writeCard(qc, target.id, r.deal, order, false);
        toast.show(r.changed_by_first_name ? tPipe("undoConflict", { name: r.changed_by_first_name }) : tPipe("undoConflictSomeone"));
        return false;
      }
      versions.set(target.id, r.deal.version);
      if (target.toStage === "lost") {
        // The card left the board when it was lost: it comes back from the Lost line.
        for (const [key, board] of qc.getQueriesData<Board>({ queryKey: ["pipeline", "board"] })) {
          if (board && !findCard(board, target.id)) qc.setQueryData<Board>(key, restoreFromLost(board, r.deal, target.lostReason, order));
        }
      }
      writeCard(qc, target.id, r.deal, order, false);
      refreshAround(qc, r.deal);
      toast.show(tPipe("undone"));
      return true;
    },
    [qc, toast, tPipe, errorText, order],
  );

  // ---- Stage changes ----------------------------------------------------------------------------------------------
  const change = useCallback(
    (card: DealCard, ch: Change): Promise<MoveResult | null> => {
      const to = targetOf(ch);
      const id = card.id;
      if (!pending.get(id)) versions.set(id, card.version);
      const gen = generation.get(id) ?? 0;
      const requestId = crypto.randomUUID();
      const patch: Partial<DealCard> =
        ch.kind === "win" ? { value: ch.value, fulfilment: ch.fulfilment } : ch.kind === "lose" ? { lost_reason: ch.reason } : {};
      const from = card.stage;
      // The move shows at once, in the same render as the focus and the settle (design 7.5: painted within 100 ms):
      // the snapshot and the optimistic write happen here, in the event, not after an awaited cancel. onMutate then
      // waits for the cancel of any board fetch in flight and puts the move back if that cancel restored an older board.
      pending.set(id, (pending.get(id) ?? 0) + 1);
      const snap = snapshot(qc, card);
      const cancelled = qc.cancelQueries({ queryKey: ["pipeline", "board"] });
      optimistic(qc, card, to, patch, order);

      const send = async (): Promise<MoveResult> => {
        if ((generation.get(id) ?? 0) !== gen) throw new Superseded();
        const version = versions.get(id) ?? card.version;
        const call = (): Promise<ActionResult<MoveResult>> =>
          ch.kind === "win"
            ? winDeal({ id, version, value: ch.value, fulfilment: ch.fulfilment, requestId })
            : ch.kind === "lose"
              ? loseDeal({ id, version, reason: ch.reason, note: ch.note, requestId })
              : ch.kind === "reopen"
                ? reopenDeal({ id, stage: ch.to, version, requestId })
                : moveDeal({ id, stage: ch.to, version, requestId });
        let res = await call();
        // Reopening a won deal after 2 minutes needs a fresh code (D8): ask, then send the same request again.
        if (!res.ok && res.error === "step_up" && stepUp && (await stepUp.requireFresh())) res = await call();
        return unwrap(res);
      };

      const observer = new MutationObserver<MoveResult, unknown, void, Snapshot>(qc, {
        scope: { id: `deal-${id}` },
        mutationFn: send,
        onMutate: async () => {
          await cancelled;
          if (!placedIn(qc, id, to)) optimistic(qc, card, to, patch, order);
          return snap;
        },
        onSuccess: (r) => {
          if (r.result === "conflict") {
            generation.set(id, (generation.get(id) ?? 0) + 1);
            if (r.deal) versions.set(id, r.deal.version);
            writeCard(qc, id, r.deal, order, false);
            toast.show(
              r.changed_by_first_name
                ? tPipe("conflict", { name: r.changed_by_first_name, stage: tStage(r.deal?.stage ?? from) })
                : tPipe("conflictSomeone", { stage: tStage(r.deal?.stage ?? from) }),
            );
            return;
          }
          versions.set(id, r.deal.version);
          const others = (pending.get(id) ?? 1) > 1;
          writeCard(qc, id, r.deal, order, others);
          refreshAround(qc, r.deal);
          if (r.result === "unchanged") return;
          const undoable = r.undo_until && !r.undone;
          setLastMove(undoable
            ? { id, historyId: r.history_id, toStage: to, fromStage: from, version: r.deal.version, at: Date.now(), until: Date.parse(r.undo_until!), leadId: card.company_id, lostReason: ch.kind === "lose" ? ch.reason : null }
            : null);
          const value = r.deal.value ? formatMoney(r.deal.value, locale) : "";
          const message =
            ch.kind === "win"
              ? r.lead_status_after === "customer"
                ? t("toast.wonCustomer", { value, lead: card.company_name })
                : t("toast.won", { value })
              : ch.kind === "lose"
                ? t("toast.lost", { reason: tReason(ch.reason) })
                : ch.kind === "reopen"
                  ? t("toast.reopened", { stage: tStage(to) })
                  : t("toast.moved", { stage: tStage(to) });
          const move = lastUndoableMove();
          showUndoToast(message, move ? () => void undo(move) : null);
        },
        onError: (e, _v, s) => {
          if (e instanceof Superseded) return; // an earlier move on this deal failed: its rollback covers this one too
          generation.set(id, (generation.get(id) ?? 0) + 1);
          if (s) restore(qc, card, s);
          const failure: ActionFailure = isFailure(e) ? e : { ok: false, error: "unavailable" };
          toast.show(failure.error === "unavailable" ? tPipe("moveFailed") : errorText(failure));
        },
        onSettled: () => {
          const n = (pending.get(id) ?? 1) - 1;
          if (n <= 0) pending.delete(id);
          else pending.set(id, n);
        },
      });
      return observer.mutate().catch(() => null);
    },
    [qc, order, stepUp, toast, tPipe, tStage, t, tReason, locale, errorText, showUndoToast, undo],
  );

  const move = useCallback((card: DealCard, to: OpenStageKey) => change(card, card.status === "open" ? { kind: "move", to } : { kind: "reopen", to }), [change]);
  const win = useCallback((card: DealCard, value: string, fulfilment: Fulfilment) => change(card, { kind: "win", value, fulfilment }), [change]);
  const lose = useCallback((card: DealCard, reason: LostReason, note: string | null) => change(card, { kind: "lose", reason, note }), [change]);
  const reopen = useCallback((card: DealCard, to: OpenStageKey) => change(card, { kind: "reopen", to }), [change]);

  // ---- Field edits (update_deal: a patch of the named fields; a conflict is a result) -------------------------------
  const update = useCallback(
    async (card: DealCard, fields: UpdateField[], values: { title?: string | null; value?: string | null; expectedClose?: string | null; fulfilment?: Fulfilment | null; contactId?: string | null; ownerId?: string | null }): Promise<UpdateResult | null> => {
      let res: ActionResult<UpdateResult>;
      try {
        res = await updateDeal({ id: card.id, version: versions.get(card.id) ?? card.version, fields, ...values });
      } catch {
        res = { ok: false, error: "unavailable" };
      }
      if (!res.ok) {
        toast.show(errorText(res));
        return null;
      }
      const r = res.data;
      if (r.deal) versions.set(card.id, r.deal.version);
      writeCard(qc, card.id, r.deal, order, false);
      if (r.result === "updated") refreshAround(qc, r.deal);
      return r;
    },
    [qc, toast, errorText, order],
  );

  // ---- Opening and deleting ---------------------------------------------------------------------------------------
  const open = useCallback(
    async (input: { leadId: string; title: string | null; value: string | null; expectedClose: string | null; fulfilment: Fulfilment | null; contactId: string | null; ownerId: string | null }): Promise<OpenResult | null> => {
      let res: ActionResult<OpenResult>;
      try {
        res = await openDeal({ ...input, requestId: crypto.randomUUID() });
      } catch {
        res = { ok: false, error: "unavailable" };
      }
      if (!res.ok) {
        toast.show(errorText(res));
        return null;
      }
      const card = res.data.deal;
      versions.set(card.id, card.version);
      for (const [key, board] of qc.getQueriesData<Board>({ queryKey: ["pipeline", "board"] })) {
        if (board && !findCard(board, card.id)) qc.setQueryData<Board>(key, replaceCard(board, card, card.id, order));
      }
      refreshAround(qc, card);
      void qc.invalidateQueries({ queryKey: ["pipeline", "board"] });
      return res.data;
    },
    [qc, toast, errorText, order],
  );

  const remove = useCallback(
    async (card: DealCard, ensureFresh?: () => Promise<boolean>): Promise<boolean> => {
      let res: ActionResult<null>;
      try {
        res = await deleteDeal({ id: card.id });
        if (!res.ok && res.error === "step_up" && ensureFresh && (await ensureFresh())) res = await deleteDeal({ id: card.id });
      } catch {
        res = { ok: false, error: "unavailable" };
      }
      if (!res.ok) {
        toast.show(errorText(res));
        return false;
      }
      for (const [key, board] of qc.getQueriesData<Board>({ queryKey: ["pipeline", "board"] })) {
        if (board) qc.setQueryData<Board>(key, removeCard(board, card.id));
      }
      qc.setQueryData(dealKey(card.id), null);
      clearLastMove((m) => m.id === card.id);
      refreshAround(qc, card);
      toast.show(t("toast.deleted"));
      return true;
    },
    [qc, toast, errorText, t],
  );

  return useMemo(
    () => ({ move, win, lose, reopen, undo, update, open, remove, errorText, format }),
    [move, win, lose, reopen, undo, update, open, remove, errorText, format],
  );
}
