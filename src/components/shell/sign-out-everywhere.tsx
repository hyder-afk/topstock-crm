"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { signOutEverywhere } from "@/app/(auth)/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, phoneSheet } from "@/components/ui/dialog";
import { FormMessage } from "@/components/ui/form-message";
import { cn } from "@/lib/utils";

// "Sign out of all devices" on More (Gate 1 item 25): a confirmation sheet (no browser popup), then the server action
// ends every session of this person and lands this browser on the sign-in screen. On failure the sheet stays open with
// a short message.
export function SignOutEverywhere() {
  const t = useTranslations("More.everywhere");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<"unavailable" | "rateLimited" | null>(null);
  const [pending, startTransition] = useTransition();

  function confirm() {
    setError(null);
    startTransition(async () => {
      const result = await signOutEverywhere();
      if (result?.error) setError(result.error);
    });
  }

  return (
    <>
      <Button type="button" variant="quiet" onClick={() => setOpen(true)}>
        {t("open")}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (pending) return;
          setOpen(next);
          if (!next) setError(null);
        }}
      >
        <DialogContent className={cn(phoneSheet, "sm:w-[min(440px,calc(100%-32px))]")}>
          <div className="flex flex-col gap-5 p-6">
            <div className="flex flex-col gap-1.5">
              <DialogTitle className="text-xl font-bold tracking-[-0.03em] text-balance">{t("title")}</DialogTitle>
              <DialogDescription className="text-sm text-muted-foreground">{t("body")}</DialogDescription>
            </div>
            <FormMessage tone="error">{error ? t(error) : null}</FormMessage>
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <Button type="button" variant="quiet" onClick={() => setOpen(false)} disabled={pending}>
                {t("cancel")}
              </Button>
              <Button type="button" variant="neutral" onClick={confirm} disabled={pending} aria-busy={pending}>
                {t("confirm")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
