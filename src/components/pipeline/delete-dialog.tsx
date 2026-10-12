"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, phoneSheet } from "@/components/ui/dialog";
import type { DealCard } from "@/lib/deals";
import { cn } from "@/lib/utils";

// Delete asks first (it cannot be undone; the deal's stage history goes with it). "Cancel" has the focus, so Enter never
// deletes by accident. The database then asks for a fresh code, except for one's own untouched deal opened under 2
// minutes ago (design D8, threat 15).
export function DeleteDealDialog({ card, onConfirm, onCancel }: { card: DealCard | null; onConfirm: () => void; onCancel: () => void }) {
  const t = useTranslations("Deals.delete");
  return (
    <Dialog open={!!card} onOpenChange={(open) => (open ? null : onCancel())}>
      {card ? (
        <DialogContent className={cn(phoneSheet, "sm:w-[min(440px,calc(100%-32px))]")}>
          <div className="flex flex-col gap-5 p-6">
            <div className="flex flex-col gap-2">
              <DialogTitle className="text-xl font-bold tracking-[-0.03em] text-balance">{t("title")}</DialogTitle>
              <DialogDescription className="text-muted-foreground">{t("body")}</DialogDescription>
            </div>
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <Button variant="quiet" onClick={onCancel} autoFocus>
                {t("cancel")}
              </Button>
              <Button variant="neutral" onClick={onConfirm}>
                {t("confirm")}
              </Button>
            </div>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
