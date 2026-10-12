"use client";

import { useId, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { ChevronDown } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, phoneSheet } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/leads/status-badge";
import { leadStatuses, type LeadStatus } from "@/lib/leads";
import { addDays, localDate, primaryZone, zonedInstant } from "@/lib/timezones";
import { cn } from "@/lib/utils";

// The status menu for people who may change the lead (Day 4 design 3.2 and 7.1). Choosing Cool off asks "Until when?"
// (30 days, 90 days or a date): the lead rests and comes back to the queue on that date at 09:00 its time. Without an
// answer nothing changes; the database also gives any Cool off without a date a 90-day return.
export function StatusMenu({
  status,
  callZoneKey,
  onChange,
  variant = "badge",
  label,
}: {
  status: LeadStatus;
  callZoneKey: string;
  onChange: (status: LeadStatus, returnAt: string | null) => void;
  variant?: "badge" | "button";
  label?: string;
}) {
  const t = useTranslations("Leads");
  const tStatus = useTranslations("Leads.status");
  const [asking, setAsking] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={variant === "badge" ? t("statusMenu", { status: tStatus(status) }) : undefined}
          className={cn(
            variant === "badge"
              ? "inline-flex min-h-11 items-center gap-1 rounded-sm transition-transform duration-150 active:scale-[0.97] sm:min-h-0"
              : cn(buttonVariants({ variant: "quiet" }), "min-h-11 px-3 text-sm sm:min-h-10"),
          )}
        >
          {variant === "badge" ? <StatusBadge status={status} /> : (label ?? t("setStatus"))}
          <ChevronDown aria-hidden="true" strokeWidth={1.75} className="size-4 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup
            value={status}
            onValueChange={(v) => {
              if (v === status) return;
              // After the menu has closed and given the focus back (a dialog opened from inside it loses its focus).
              if (v === "cool_off") window.setTimeout(() => setAsking(true), 0);
              else onChange(v as LeadStatus, null);
            }}
          >
            {leadStatuses.map((s) => (
              <DropdownMenuRadioItem key={s} value={s}>
                {tStatus(s)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <UntilDialog
        open={asking}
        callZoneKey={callZoneKey}
        onCancel={() => setAsking(false)}
        onConfirm={(returnAt) => {
          setAsking(false);
          onChange("cool_off", returnAt);
        }}
      />
    </>
  );
}

const choices = ["d30", "d90", "pick"] as const;

function UntilDialog({
  open,
  callZoneKey,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  callZoneKey: string;
  onCancel: () => void;
  onConfirm: (returnAt: string) => void;
}) {
  const t = useTranslations("Leads.until");
  const format = useFormatter();
  const id = useId();
  const zone = primaryZone(callZoneKey);
  const [choice, setChoice] = useState<(typeof choices)[number]>("d90");
  const [picked, setPicked] = useState("");
  const today = localDate(zone, new Date());
  const date = choice === "d30" ? addDays(today, 30) : choice === "d90" ? addDays(today, 90) : picked;
  const valid = !!date && date > today && date <= addDays(today, 730);
  const label = (d: string) => format.dateTime(new Date(`${d}T12:00:00Z`), { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onCancel())}>
      <DialogContent className={cn(phoneSheet, "sm:w-[min(440px,calc(100%-32px))]")}>
        <form
          className="flex flex-col gap-5 p-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) onConfirm(zonedInstant(date, "09:00", zone).toISOString());
          }}
        >
          <div className="flex flex-col gap-2">
            <DialogTitle className="text-xl font-bold text-balance">{t("title")}</DialogTitle>
            <DialogDescription className="text-muted-foreground">{t("body")}</DialogDescription>
          </div>
          <fieldset className="flex flex-col gap-1">
            <legend className="sr-only">{t("title")}</legend>
            {choices.map((c) => (
              <label key={c} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-muted/50">
                <input
                  type="radio"
                  name={`${id}-until`}
                  value={c}
                  checked={choice === c}
                  onChange={() => setChoice(c)}
                  className="size-4 accent-foreground"
                />
                <span className="flex flex-1 flex-wrap items-baseline justify-between gap-x-3">
                  <span>{t(c)}</span>
                  {c !== "pick" ? (
                    <span className="font-mono text-sm text-muted-foreground">{label(addDays(today, c === "d30" ? 30 : 90))}</span>
                  ) : null}
                </span>
              </label>
            ))}
            {choice === "pick" ? (
              <input
                type="date"
                aria-label={t("pick")}
                value={picked}
                min={addDays(today, 1)}
                max={addDays(today, 730)}
                onChange={(e) => setPicked(e.target.value)}
                className="mt-1 min-h-11 rounded-md border border-border bg-background px-3 font-mono text-sm text-foreground"
              />
            ) : null}
          </fieldset>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="quiet" onClick={onCancel}>
              {t("cancel")}
            </Button>
            <Button type="submit" variant="neutral" aria-disabled={!valid || undefined}>
              {t("confirm")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
