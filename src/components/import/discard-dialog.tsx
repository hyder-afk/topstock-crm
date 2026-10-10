"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, phoneSheet } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// Discard asks first: the checked rows are thrown away (nothing was added to the CRM, and the file can be checked
// again). A small dialog, a bottom sheet on phones; "Keep it" has the focus, so Enter never discards by accident.
export function DiscardDialog({
  open,
  onKeep,
  onConfirm,
  onCloseFocus,
}: {
  open: boolean;
  onKeep: () => void;
  onConfirm: () => void;
  // Where focus goes once the dialog has closed (the button that opened it may be gone by then).
  onCloseFocus: () => void;
}) {
  const t = useTranslations("Import.discardConfirm");
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onKeep())}>
      <DialogContent
        className={cn(phoneSheet, "sm:w-[min(440px,calc(100%-32px))]")}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onCloseFocus();
        }}
      >
        <div className="flex flex-col gap-5 p-6">
          <div className="flex flex-col gap-2">
            <DialogTitle className="text-xl font-bold tracking-[-0.03em] text-balance">{t("title")}</DialogTitle>
            <DialogDescription className="text-muted-foreground">{t("body")}</DialogDescription>
          </div>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="quiet" onClick={onKeep}>
              {t("keep")}
            </Button>
            <Button variant="neutral" onClick={onConfirm}>
              {t("confirm")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
