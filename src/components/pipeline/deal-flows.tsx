"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { lastUndoable } from "@/components/activity/use-activities";
import { useStepUp } from "@/components/auth/step-up-dialog";
import { DeleteDealDialog } from "@/components/pipeline/delete-dialog";
import { LoseDialog } from "@/components/pipeline/lose-dialog";
import { ReopenDialog } from "@/components/pipeline/reopen-dialog";
import { useDealActions } from "@/components/pipeline/use-pipeline";
import { WinDialog } from "@/components/pipeline/win-dialog";
import { reopenStage, type DealCard, type OpenStageKey, type SortOrder } from "@/lib/deals";
import { lastUndoableMove } from "@/lib/last-move";
import { dealKey, fetchDealClient } from "@/lib/prefetch";
import { isTyping } from "@/lib/shortcuts";
import { isUndoKey, newerUndo } from "@/lib/undo-pick";

// The dialogs around a deal's lifecycle (Win, Lose, Reopen, Delete) and the two "Confirm it's you" dialogs (reopening a
// won deal, deleting), shared by the board, the deal sheet and the lead's Deals tab. A dialog opened from a drop calls
// `onSettled(false)` when it is cancelled, so the board springs the card back (design 7.3: Cancel is a drag cancel).
// `undoKey` (the lead page and Home's deal sheet): U and Cmd/Ctrl+Z take back the last deal move when it is newer than
// the last logged entry (design 5.3); the app-wide call panel takes the entry otherwise. The board has its own U.
export function useDealFlows(stepUpSeconds: number, order: SortOrder = "recent", opts: { undoKey?: boolean } = {}) {
  const reopenStepUp = useStepUp(stepUpSeconds, "bodyReopenWon");
  const deleteStepUp = useStepUp(stepUpSeconds, "bodyDeleteDeal");
  const { requireFresh: requireReopen } = reopenStepUp;
  const stepUp = useMemo(() => ({ requireFresh: requireReopen }), [requireReopen]);
  const actions = useDealActions({ order, stepUp });
  const [win, setWin] = useState<{ card: DealCard; done?: (ok: boolean) => void } | null>(null);
  const [lose, setLose] = useState<{ card: DealCard; done?: (ok: boolean) => void } | null>(null);
  const [reopen, setReopen] = useState<{ card: DealCard; stage: OpenStageKey; done?: (ok: boolean) => void } | null>(null);
  const queryClient = useQueryClient();
  const [remove, setRemove] = useState<{ card: DealCard; done?: (ok: boolean) => void } | null>(null);

  const openWin = useCallback((card: DealCard, done?: (ok: boolean) => void) => setWin({ card, done }), []);
  // A caller that passes `done` places the focus itself (the board: the lost card leaves, so its neighbour takes it);
  // the dialog then leaves the focus alone on close instead of sending it back to an opener that may be gone.
  const loseOwnsFocus = useRef(false);
  const openLose = useCallback((card: DealCard, done?: (ok: boolean) => void) => {
    loseOwnsFocus.current = !!done;
    setLose({ card, done });
  }, []);
  const openReopen = useCallback(
    (card: DealCard, stage: OpenStageKey, done?: (ok: boolean) => void) => {
      // A lost deal reopens in one click (design 1.3); a won one asks first (it leaves the month's won total).
      if (card.status === "lost") void actions.reopen(card, stage).then((r) => done?.(!!r));
      else setReopen({ card, stage, done });
    },
    [actions],
  );
  // Reopen from a list (the board's card menu, the lead's Deals tab), where the card does not carry its history: the
  // deal reopens in the stage it was closed from (design 7.6), read from get_deal's history (cached for the sheet). If
  // that cannot be read, the stage chooser opens instead of guessing (a guess can change the lead's status, D-5.4).
  const reopenFromHistory = useCallback(
    async (card: DealCard, done?: (ok: boolean) => void) => {
      let stage: OpenStageKey | null = null;
      try {
        const deal = await queryClient.fetchQuery({ queryKey: dealKey(card.id), queryFn: () => fetchDealClient(card.id), staleTime: 10_000 });
        if (deal) stage = reopenStage(deal.history);
      } catch {
        stage = null;
      }
      if (stage) openReopen(card, stage, done);
      else setReopen({ card, stage: reopenStage([]), done });
    },
    [queryClient, openReopen],
  );
  const openDelete = useCallback((card: DealCard, done?: (ok: boolean) => void) => setRemove({ card, done }), []);

  const undoKey = !!opts.undoKey;
  const undoMove = actions.undo;
  useEffect(() => {
    if (!undoKey) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || isTyping(event.target)) return;
      if (document.querySelector("[role=dialog],[data-owns-undo]")) return;
      if (!isUndoKey(event)) return;
      const pick = newerUndo(lastUndoable(), lastUndoableMove());
      if (pick?.kind !== "move") return;
      event.preventDefault();
      void undoMove(pick.move);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undoKey, undoMove]);

  const dialogs = (
    <>
      <WinDialog
        card={win?.card ?? null}
        onCancel={() => {
          win?.done?.(false);
          setWin(null);
        }}
        onConfirm={(value, fulfilment) => {
          const w = win;
          setWin(null);
          if (!w) return;
          void actions.win(w.card, value, fulfilment);
          w.done?.(true);
        }}
      />
      <LoseDialog
        card={lose?.card ?? null}
        onCloseAutoFocus={(e) => {
          if (loseOwnsFocus.current) e.preventDefault();
        }}
        onCancel={() => {
          lose?.done?.(false);
          setLose(null);
        }}
        onConfirm={(reason, note) => {
          const l = lose;
          setLose(null);
          if (!l) return;
          void actions.lose(l.card, reason, note);
          l.done?.(true);
        }}
      />
      <ReopenDialog
        card={reopen?.card ?? null}
        initialStage={reopen?.stage ?? "negotiations"}
        onCancel={() => {
          reopen?.done?.(false);
          setReopen(null);
        }}
        onConfirm={(stage) => {
          const r = reopen;
          setReopen(null);
          if (r) void actions.reopen(r.card, stage).then((ok) => r.done?.(!!ok));
        }}
      />
      <DeleteDealDialog
        card={remove?.card ?? null}
        onCancel={() => {
          remove?.done?.(false);
          setRemove(null);
        }}
        onConfirm={() => {
          const r = remove;
          setRemove(null);
          if (!r) return;
          void actions.remove(r.card, () => deleteStepUp.requireFresh()).then((ok) => r.done?.(ok));
        }}
      />
      {reopenStepUp.dialog}
      {deleteStepUp.dialog}
    </>
  );

  return { actions, openWin, openLose, openReopen, reopenFromHistory, openDelete, dialogs };
}
