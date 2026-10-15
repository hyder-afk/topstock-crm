"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, phoneSheet } from "@/components/ui/dialog";
import { openStageKeys, type DealCard, type OpenStageKey } from "@/lib/deals";
import { cn } from "@/lib/utils";

// Reopen (Day 5 design 7.6): "Reopen in {stage}", defaulting to the stage the deal was closed from. A won deal says
// first that it leaves this month's won total; after 2 minutes the database also asks for a fresh code (the caller's
// step-up dialog). A lost deal reopens in one click from the menus; this dialog is for choosing the stage.
export function ReopenDialog({
  card,
  initialStage,
  onConfirm,
  onCancel,
}: {
  card: DealCard | null;
  initialStage: OpenStageKey;
  onConfirm: (stage: OpenStageKey) => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={!!card} onOpenChange={(open) => (open ? null : onCancel())}>
      {card ? <ReopenForm key={card.id} card={card} initialStage={initialStage} onConfirm={onConfirm} onCancel={onCancel} /> : null}
    </Dialog>
  );
}

function ReopenForm({ card, initialStage, onConfirm, onCancel }: { card: DealCard; initialStage: OpenStageKey; onConfirm: (stage: OpenStageKey) => void; onCancel: () => void }) {
  const t = useTranslations("Deals.reopen");
  const tStage = useTranslations("Stages");
  const [stage, setStage] = useState<OpenStageKey>(initialStage);
  return (
    <DialogContent className={cn(phoneSheet, "sm:w-[min(440px,calc(100%-32px))]")}>
      <div className="flex flex-col gap-5 p-6">
        <div className="flex flex-col gap-1.5">
          <DialogTitle className="text-xl font-bold tracking-[-0.03em] text-balance">{t("title")}</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">{card.status === "won" ? t("wonConfirm") : t("body")}</DialogDescription>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-bold">{t("stage")}</legend>
          {openStageKeys.map((s) => (
            <label key={s} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-border px-3 text-sm has-[:checked]:border-foreground has-[:checked]:bg-muted">
              <input type="radio" name="reopen-stage" value={s} checked={stage === s} onChange={() => setStage(s)} className="size-4 accent-[var(--foreground)]" />
              {tStage(s)}
            </label>
          ))}
        </fieldset>
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button variant="quiet" onClick={onCancel}>
            {t("cancel")}
          </Button>
          <Button variant="neutral" onClick={() => onConfirm(stage)}>
            {t("submit")}
          </Button>
        </div>
      </div>
    </DialogContent>
  );
}
