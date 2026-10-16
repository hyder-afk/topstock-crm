"use client";

import { useId } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { LeadPicker } from "@/components/sales/pickers";
import { Dialog, DialogContent, DialogDescription, DialogTitle, phoneSheet } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// Cmd+K "Share stock with…" (design 10.1 and 10.4): a lead search; picking a lead opens its Stock tab, where the client
// link card makes, sends and lists the links (one place for the code, the options and the address shown once).
export function ShareWithDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations("ShareLinks");
  const router = useRouter();
  const id = useId();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={`${id}-desc`} className={cn(phoneSheet, "sm:w-[min(520px,calc(100%-32px))]")}>
        <div className="flex flex-col gap-4 p-5 sm:p-6">
          <div className="flex flex-col gap-1">
            <DialogTitle className="text-xl font-bold tracking-[-0.03em]">{t("pickTitle")}</DialogTitle>
            <DialogDescription id={`${id}-desc`} className="text-sm text-muted-foreground">
              {t("pickBody")}
            </DialogDescription>
          </div>
          <LeadPicker
            label={t("pickLabel")}
            autoFocus
            onPick={(lead) => {
              onOpenChange(false);
              router.push(`/leads/${lead.id}?tab=stock`);
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
