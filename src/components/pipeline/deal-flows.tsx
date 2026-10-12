"use client";

import { useCallback, useMemo, useState } from "react";
import { useStepUp } from "@/components/auth/step-up-dialog";
import { DeleteDealDialog } from "@/components/pipeline/delete-dialog";
import { LoseDialog } from "@/components/pipeline/lose-dialog";
import { ReopenDialog } from "@/components/pipeline/reopen-dialog";
import { useDealActions } from "@/components/pipeline/use-pipeline";
import { WinDialog } from "@/components/pipeline/win-dialog";
import type { DealCard, OpenStageKey, SortOrder } from "@/lib/deals";

// The dialogs around a deal's lifecycle (Win, Lose, Reopen, Delete) and the two "Confirm it's you" dialogs (reopening a
// won deal, deleting), shared by the board, the deal sheet and the lead's Deals tab. A dialog opened from a drop calls
// `onSettled(false)` when it is cancelled, so the board springs the card back (design 7.3: Cancel is a drag cancel).
export function useDealFlows(stepUpSeconds: number, order: SortOrder = "recent") {
  const reopenStepUp = useStepUp(stepUpSeconds, "bodyReopenWon");
  const deleteStepUp = useStepUp(stepUpSeconds, "bodyDeleteDeal");
  const { requireFresh: requireReopen } = reopenStepUp;
  const stepUp = useMemo(() => ({ requireFresh: requireReopen }), [requireReopen]);
  const actions = useDealActions({ order, stepUp });
  const [win, setWin] = useState<{ card: DealCard; done?: (ok: boolean) => void } | null>(null);
  const [lose, setLose] = useState<{ card: DealCard; done?: (ok: boolean) => void } | null>(null);
  const [reopen, setReopen] = useState<{ card: DealCard; stage: OpenStageKey } | null>(null);
  const [remove, setRemove] = useState<{ card: DealCard; done?: (ok: boolean) => void } | null>(null);

  const openWin = useCallback((card: DealCard, done?: (ok: boolean) => void) => setWin({ card, done }), []);
  const openLose = useCallback((card: DealCard, done?: (ok: boolean) => void) => setLose({ card, done }), []);
  const openReopen = useCallback(
    (card: DealCard, stage: OpenStageKey) => {
      // A lost deal reopens in one click (design 1.3); a won one asks first (it leaves the month's won total).
      if (card.status === "lost") void actions.reopen(card, stage);
      else setReopen({ card, stage });
    },
    [actions],
  );
  const openDelete = useCallback((card: DealCard, done?: (ok: boolean) => void) => setRemove({ card, done }), []);

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
        onCancel={() => setReopen(null)}
        onConfirm={(stage) => {
          const r = reopen;
          setReopen(null);
          if (r) void actions.reopen(r.card, stage);
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

  return { actions, openWin, openLose, openReopen, openDelete, dialogs };
}
