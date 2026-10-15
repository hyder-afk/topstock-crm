"use client";

import { forwardRef, useState } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { CalendarClock, ListTodo, Phone } from "lucide-react";
import { StatusBadge } from "@/components/leads/status-badge";
import { useClientNow } from "@/components/lead/local-time";
import { countryName } from "@/lib/countries";
import { personName, type LeadStatus } from "@/lib/leads";
import { callHref } from "@/lib/phone";
import type { QueueCard as Card } from "@/lib/queue";
import { isOpen, localDate, openUntilMinutes, primaryZone, spanEnds, zonedInstant } from "@/lib/timezones";
import { cn } from "@/lib/utils";

/** The number a call goes to: the lead's main line, or one contact's. */
export type Dialled = { kind: "lead" } | { kind: "contact"; contactId: string };

/** The number C dials and Wrong number marks: the main line when it works, else the first contact with a working one. */
export function defaultDial(card: Card): Dialled | null {
  if (card.phone && /\d/.test(card.phone) && !card.phone_wrong) return { kind: "lead" };
  const contact = card.contacts.find((c) => c.phone && /\d/.test(c.phone) && !c.phone_wrong);
  if (contact) return { kind: "contact", contactId: contact.id };
  if (card.phone && /\d/.test(card.phone)) return { kind: "lead" };
  return null;
}

export function dialNumber(card: Card, d: Dialled | null): string | null {
  if (!d) return null;
  if (d.kind === "lead") return card.phone;
  return card.contacts.find((c) => c.id === d.contactId)?.phone ?? null;
}

const FRENCH_COUNTRIES = new Set(["FR", "BE", "LU", "CH", "MC", "MA", "DZ", "TN", "SN", "CI", "CM", "RE", "GP", "MQ", "GF", "YT", "NC", "PF", "CA"]);
const time = (format: ReturnType<typeof useFormatter>, at: Date, zone: string) => format.dateTime(at, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: zone });

// One lead in the queue (Day 4 design 7.4): a region labelled by its h2 (focused after each advance). The name, the
// status, the reason ("Follow-up due 10:00", "First call", "Retry · 3rd try"), "Lyon, France · 10:42 their time · open
// until 18:00", the numbers in large DM Mono each with its own Call (the main line red; C dials the chosen number), the
// contacts, the last 3 notes, my open tasks, a collapsible script (EN or FR by country, with a switch), and the next
// lead. Text is shown as text only (dir="auto"), never as HTML.
export const QueueCardView = forwardRef<HTMLHeadingElement, {
  card: Card;
  next: Card | null;
  dialled: Dialled | null;
  onDial: (d: Dialled) => void;
  skipLunch: boolean;
  /** The caller's first name for the script (null: the script without a name). */
  me: string | null;
  /** The caller's profile zone: a follow-up's time reads as on the Tasks page. */
  profileZone: string;
  changedStatus: string | null;
  claiming: boolean;
  part: "head" | "details";
  headingId?: string;
}>(function QueueCardView({ card, next, dialled, onDial, skipLunch, me, profileZone, changedStatus, claiming, part, headingId }, ref) {
  const t = useTranslations("Queue");
  const tOut = useTranslations("Outcomes");
  const tTypes = useTranslations("Composer.types");
  const tLeads = useTranslations("Leads");
  const format = useFormatter();
  const locale = useLocale();
  const now = useClientNow(30_000);
  const [scriptLang, setScriptLang] = useState<"en" | "fr" | null>(null);
  const zoneKey = card.call_zone;
  const ends = spanEnds(zoneKey);
  const zone = primaryZone(zoneKey);
  const open = now ? isOpen(zoneKey, now, skipLunch) : card.local_time_open;
  const place = [card.city, card.country ? countryName(card.country, locale) : null].filter(Boolean).join(", ");
  const status = (changedStatus ?? card.lead_status) as LeadStatus;

  if (part === "head") {
    const followTask = card.reason === "follow_up" ? card.my_open_tasks.find((x) => x.kind === "call") : undefined;
    const reason =
      card.reason === "follow_up" && followTask?.due_at
        ? t("reason.followUpAt", { time: time(format, new Date(followTask.due_at), profileZone) })
        : card.reason === "retry" && card.attempts > 0
          ? t("reason.retryNth", { count: card.attempts + 1 })
          : t(`reason.${card.reason}`);
    let clock: string | null = null;
    if (now && card.country) {
      if (ends) clock = t("spanTime", { from: time(format, now, ends[1]), to: time(format, now, ends[0]) });
      else clock = open ? t("theirTime", { time: time(format, now, zone) }) : t("outsideCard", { time: time(format, now, zone) });
    }
    // The end of calling hours on the lead's side today (12:00 before lunch with the lunch switch on, in Europe), worded
    // by Intl in that zone.
    const endsAt = now ? openUntilMinutes(zone, now, skipLunch) : 0;
    const until = now ? time(format, zonedInstant(localDate(zone, now), `${String(endsAt / 60).padStart(2, "0")}:00`, zone), zone) : "";
    const mainNumber = card.phone && /\d/.test(card.phone) ? card.phone : null;
    return (
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {/* Warm and Negotiation are the status itself: the badge says it once. */}
          {card.reason !== "warm" && card.reason !== "negotiation" ? (
            <span className="inline-flex min-h-7 items-center rounded-sm bg-muted px-2 font-mono text-xs">{reason}</span>
          ) : null}
          <StatusBadge status={status} />
          {card.owner ? (
            <span className="text-sm text-muted-foreground">{t("owner", { name: personName(card.owner) || tLeads("noName") })}</span>
          ) : (
            <span className="text-sm text-muted-foreground">{t("unassigned")}</span>
          )}
        </div>
        <h2 ref={ref} id={headingId} tabIndex={-1} dir="auto" className="text-[26px] leading-8 font-bold break-words focus-visible:outline-offset-4 sm:text-3xl sm:leading-9">
          {card.name}
        </h2>
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
          {place ? <span>{place}</span> : <span className="text-muted-foreground">{t("noCountry")}</span>}
          {clock ? (
            <>
              <span aria-hidden="true" className="text-muted-foreground">·</span>
              <span className={cn("inline-flex items-center gap-1.5", !open && "font-bold text-status-amber")}>
                <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", open ? "bg-status-green" : "bg-status-amber")} />
                <span className="font-mono text-[0.8125rem]">{clock}</span>
              </span>
            </>
          ) : null}
          {clock && open && !ends ? (
            <span className="text-muted-foreground">
              <span aria-hidden="true" className="max-sm:hidden">· </span>
              {t("openUntil", { time: until })}
            </span>
          ) : null}
        </p>
        {!card.can_edit ? (
          <p className="text-sm text-muted-foreground">{t("readOnly", { owner: card.owner ? personName(card.owner) : tLeads("unassigned") })}</p>
        ) : null}
        {/* The main line: its own Call, in Signal Red (the screen's one red action); C dials the chosen number. */}
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          {mainNumber ? (
            <>
              <a
                href={callHref(mainNumber, card.country)}
                onClick={() => onDial({ kind: "lead" })}
                aria-keyshortcuts="c"
                aria-label={t("callNumber", { number: mainNumber })}
                data-queue-call="lead"
                className="inline-flex min-h-14 items-center gap-2 rounded-md bg-brand px-5 text-lg font-bold text-brand-foreground transition-[filter,transform] duration-150 hover:brightness-105 active:scale-[0.97] max-sm:w-full max-sm:justify-center sm:min-h-12"
              >
                <Phone aria-hidden="true" strokeWidth={2} className="size-5" />
                {t("call")}
              </a>
              <span translate="no" className={cn("font-mono text-2xl tabular-nums sm:text-[28px]", card.phone_wrong && "text-muted-foreground line-through")}>
                {mainNumber}
              </span>
              {card.phone_wrong ? <span className="text-sm text-muted-foreground">{t("wrongMark")}</span> : null}
            </>
          ) : (
            <span className="text-sm text-muted-foreground">{t("noPhoneMain")}</span>
          )}
        </div>
      </div>
    );
  }

  const lang = scriptLang ?? (card.country && FRENCH_COUNTRIES.has(card.country) && card.country !== "CA" ? "fr" : locale === "fr" && !card.country ? "fr" : "en");
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {card.contacts.length ? (
        <section aria-label={t("contacts")} className="flex flex-col gap-2">
          <h3 className="text-sm font-bold text-muted-foreground">{t("contacts")}</h3>
          <ul className="flex flex-col gap-1">
            {card.contacts.map((c) => {
              const usable = c.phone && /\d/.test(c.phone);
              return (
                <li key={c.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted/60 px-3 py-2">
                  {/* The name takes a line of its own when the row is narrow (phones), never cut to "A…". */}
                  <span className="min-w-[10rem] flex-1">
                    <span className="block text-sm font-bold break-words" dir="auto">
                      {personName(c) || tLeads("noName")}
                    </span>
                    {c.title ? <span className="block text-xs break-words text-muted-foreground">{c.title}</span> : null}
                  </span>
                  {c.phone ? (
                    <span translate="no" className={cn("font-mono text-base", c.phone_wrong && "text-muted-foreground line-through")}>
                      {c.phone}
                    </span>
                  ) : null}
                  {c.phone_wrong ? <span className="text-xs text-muted-foreground">{t("wrongMark")}</span> : null}
                  {usable ? (
                    <a
                      href={callHref(c.phone as string, card.country)}
                      onClick={() => onDial({ kind: "contact", contactId: c.id })}
                      aria-label={t("callNumber", { number: c.phone as string })}
                      aria-current={dialled?.kind === "contact" && dialled.contactId === c.id ? "true" : undefined}
                      className="inline-flex min-h-11 items-center gap-1.5 rounded-md bg-card px-3 text-sm font-bold transition-[filter,transform] duration-150 hover:brightness-95 active:scale-[0.97] sm:min-h-9 dark:hover:brightness-125"
                    >
                      <Phone aria-hidden="true" strokeWidth={1.75} className="size-4" />
                      {t("call")}
                    </a>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section aria-label={t("lastNotes")} className="flex flex-col gap-2">
        <h3 className="text-sm font-bold text-muted-foreground">{t("lastNotes")}</h3>
        {card.recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noNotes")}</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {card.recent.map((a) => (
              <li key={a.id} className="flex flex-col gap-0.5 text-sm">
                <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                  <span className="font-bold text-foreground">
                    {a.type === "call" && a.outcome ? `${tTypes("call")} · ${tOut(a.outcome)}` : tTypes(a.type)}
                  </span>
                  {a.user_first_name ? <span>{a.user_first_name}</span> : null}
                  {now ? (
                    <time dateTime={a.created_at} title={format.dateTime(new Date(a.created_at), { dateStyle: "medium", timeStyle: "short" })}>
                      {format.relativeTime(new Date(a.created_at), now)}
                    </time>
                  ) : null}
                </span>
                {a.body ? (
                  <p dir="auto" className="line-clamp-3 whitespace-pre-wrap [unicode-bidi:plaintext]">
                    {a.body}
                    {a.truncated ? "…" : ""}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      {card.my_open_tasks.length ? (
        <section aria-label={t("myTasks")} className="flex flex-col gap-2">
          <h3 className="text-sm font-bold text-muted-foreground">{t("myTasks")}</h3>
          <ul className="flex flex-col gap-1">
            {card.my_open_tasks.map((task) => {
              const Icon = task.kind === "call" ? Phone : task.kind === "meeting" ? CalendarClock : ListTodo;
              return (
                <li key={task.id} className="flex items-center gap-2 text-sm">
                  <Icon aria-hidden="true" strokeWidth={1.75} className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate" dir="auto">
                    {task.title}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {task.due_at
                      ? format.dateTime(new Date(task.due_at), { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
                      : task.due_date
                        ? format.dateTime(new Date(`${task.due_date}T12:00:00Z`), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })
                        : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <details className="group rounded-md bg-muted/60 px-3 py-2 [&_summary::-webkit-details-marker]:hidden">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 text-sm font-bold sm:min-h-9">
          {t("script.title")}
          <span aria-hidden="true" className="text-muted-foreground transition-transform duration-150 group-open:rotate-90">›</span>
        </summary>
        <div className="flex flex-col gap-2 pb-1">
          <p lang={lang} className="max-w-[65ch] text-sm text-pretty">
            {me ? t(`script.${lang}`, { me, lead: card.name }) : t(`script.${lang}NoName`, { lead: card.name })}
          </p>
          <button
            type="button"
            onClick={() => setScriptLang(lang === "fr" ? "en" : "fr")}
            className="min-h-11 self-start text-sm font-bold underline-offset-4 hover:underline sm:min-h-0"
          >
            {lang === "fr" ? t("script.inEnglish") : t("script.inFrench")}
          </button>
        </div>
      </details>

      {next || claiming ? (
        <p className="text-sm text-muted-foreground">
          {next ? (next.city ? t("nextPlace", { name: next.name, place: next.city }) : t("next", { name: next.name })) : t("nextLoading")}
        </p>
      ) : null}
    </div>
  );
});
