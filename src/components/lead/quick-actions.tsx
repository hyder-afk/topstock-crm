"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { CalendarPlus, Mail, MessageCircle, NotebookPen, Phone, X } from "lucide-react";
import { useCallPanel } from "@/components/activity/call-panel";
import { useLogActivity } from "@/components/activity/use-activities";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { callTarget, leadEmails, workingNumbers, type EmailChoice, type NumberChoice } from "@/components/lead/lead-data";
import { mailHref, personName, type LeadDetail } from "@/lib/leads";
import { callHref, whatsappHref } from "@/lib/phone";
import { cn } from "@/lib/utils";

// Quick actions (Day 4 design 7.1): Call (red: the one accent), WhatsApp, Email, Meeting, Note. A missing channel is a
// hint, not a disabled button. After WhatsApp or Email opens, a chip offers to log it with one tap (with Undo).
// Phones: five equal labelled icon actions; from tablet width, a row of labelled buttons.
const item =
  "group flex min-w-0 flex-1 flex-col items-center gap-1.5 text-xs text-muted-foreground transition-transform duration-150 active:scale-[0.97] sm:flex-none sm:flex-row sm:gap-2 sm:rounded-md sm:bg-muted sm:px-4 sm:py-0 sm:min-h-11 sm:text-sm sm:font-bold sm:text-foreground sm:hover:brightness-95 dark:sm:hover:brightness-125";
const circle =
  "grid size-12 place-items-center rounded-full bg-muted text-foreground sm:size-auto sm:rounded-none sm:bg-transparent";

export function QuickActions({
  lead,
  onComposer,
  onShowDetails,
}: {
  lead: LeadDetail;
  onComposer: (mode: "note" | "meeting") => void;
  onShowDetails: () => void;
}) {
  const t = useTranslations("QuickActions");
  const { startCall } = useCallPanel();
  const log = useLogActivity();
  const [chip, setChip] = useState<{ kind: "whatsapp" | "email"; contactId: string | null; contactName: string | null } | null>(null);
  const numbers = workingNumbers(lead);
  const main: NumberChoice | undefined = numbers[0];
  const whatsapp = numbers.map((n) => ({ n, href: whatsappHref(n.number, lead.country) })).find((x) => x.href);
  const emails = leadEmails(lead);
  const ownerName = lead.owner ? personName(lead.owner) || null : null;

  const logChip = async () => {
    if (!chip) return;
    const current = chip;
    setChip(null);
    const res = await log({
      input: {
        leadId: lead.id,
        type: current.kind,
        outcome: "sent",
        body: "",
        contactId: current.contactId,
        dialled: null,
        followUpDate: null,
        followUpAt: null,
        leadName: lead.name,
      },
      preview: { contact_name: current.contactName },
      ownerName,
    });
    if (!res.ok) setChip(current);
  };

  const emailLink = (e: EmailChoice) => ({
    href: mailHref(e.address),
    onClick: () => setChip({ kind: "email", contactId: e.contactId, contactName: e.contactName }),
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2 sm:flex-wrap">
        {main ? (
          <a
            href={callHref(main.number, lead.country)}
            onClick={(e) => startCall(callTarget(lead, main), e.currentTarget)}
            className={cn(item, "sm:bg-brand sm:text-brand-foreground sm:hover:brightness-105")}
          >
            <span className={cn(circle, "bg-brand text-brand-foreground sm:bg-transparent")}>
              <Phone aria-hidden="true" strokeWidth={2} className="size-5 sm:size-4" />
            </span>
            {t("call")}
          </a>
        ) : null}
        {whatsapp ? (
          <a
            href={whatsapp.href ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setChip({ kind: "whatsapp", contactId: whatsapp.n.contactId, contactName: whatsapp.n.contactName })}
            className={item}
          >
            <span className={circle}>
              <MessageCircle aria-hidden="true" strokeWidth={1.75} className="size-5 sm:size-4" />
            </span>
            {t("whatsapp")}
          </a>
        ) : null}
        {emails.length === 1 ? (
          <a {...emailLink(emails[0])} className={item}>
            <span className={circle}>
              <Mail aria-hidden="true" strokeWidth={1.75} className="size-5 sm:size-4" />
            </span>
            {t("email")}
          </a>
        ) : emails.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger className={item}>
              <span className={circle}>
                <Mail aria-hidden="true" strokeWidth={1.75} className="size-5 sm:size-4" />
              </span>
              {t("email")}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {emails.map((e) => (
                <DropdownMenuItem key={e.address + (e.contactId ?? "")} asChild>
                  <a {...emailLink(e)}>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{e.address}</span>
                      <span className="text-xs text-muted-foreground">{e.contactName ?? t("mainAddress")}</span>
                    </span>
                  </a>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <button type="button" onClick={() => onComposer("meeting")} className={item}>
          <span className={circle}>
            <CalendarPlus aria-hidden="true" strokeWidth={1.75} className="size-5 sm:size-4" />
          </span>
          {t("meeting")}
        </button>
        <button type="button" onClick={() => onComposer("note")} className={item}>
          <span className={circle}>
            <NotebookPen aria-hidden="true" strokeWidth={1.75} className="size-5 sm:size-4" />
          </span>
          {t("note")}
        </button>
      </div>

      {/* Hints for missing channels (editors can add the number on Details). */}
      {!main || (main && !whatsapp) || emails.length === 0 ? (
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          {!main ? (
            lead.can_edit ? (
              <button type="button" onClick={onShowDetails} className="min-h-11 underline-offset-4 hover:underline sm:min-h-0">
                {t("noPhoneAdd")}
              </button>
            ) : (
              <span>{t("noPhone")}</span>
            )
          ) : !whatsapp ? (
            <span>{t("whatsappNeedsCode")}</span>
          ) : null}
          {emails.length === 0 ? <span>{t("noEmail")}</span> : null}
        </p>
      ) : null}

      {chip ? (
        <div className="flex items-center gap-1 self-start rounded-md bg-muted pl-1">
          <button
            type="button"
            onClick={() => void logChip()}
            className="min-h-11 rounded-md px-3 text-sm font-bold underline-offset-4 transition-transform duration-150 hover:underline active:scale-[0.97] sm:min-h-9"
          >
            {chip.kind === "whatsapp" ? t("logWhatsapp") : t("logEmail")}
          </button>
          <button
            type="button"
            onClick={() => setChip(null)}
            aria-label={t("dismissLog")}
            className="grid size-11 place-items-center rounded-md text-muted-foreground transition-[color,transform] duration-150 hover:text-foreground active:scale-[0.97] sm:size-9"
          >
            <X aria-hidden="true" strokeWidth={1.75} className="size-4" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
