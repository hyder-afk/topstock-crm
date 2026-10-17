"use client";

import { memo, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { FollowUpPicker, OutcomePad, followUpArgs, followUpReady, noFollowUp, type FollowUp } from "@/components/activity/outcome-pad";
import { typeIcon } from "@/components/activity/timeline";
import { useLogActivity } from "@/components/activity/use-activities";
import { leadEmails, leadNumbers } from "@/components/lead/lead-data";
import { ComposerDealChip } from "@/components/lead/deal-chip";
import { useLeadDeals } from "@/components/lead/deals-tab";
import {
  ACTIVITY_TYPES,
  BODY_COUNTER_FROM,
  BODY_MAX,
  UNSAFE_TEXT,
  followUpRule,
  outcomeForKey,
  textLength,
  type ActivityType,
  type CallOutcome,
  type Outcome,
} from "@/lib/activities";
import { readDraftRaw, writeDraft } from "@/lib/drafts";
import { MAILTO_BODY_MAX, mailtoHref, personName, type LeadDetail } from "@/lib/leads";
import { whatsappHref } from "@/lib/phone";
import { isTyping } from "@/lib/shortcuts";
import { browserZone, nextWorkingDate } from "@/lib/timezones";
import { useModKey } from "@/lib/use-platform";
import { cn } from "@/lib/utils";

// The composer (Day 4 design 7.2): logs a note, a call (the outcome pad, shared with the call panel), an email (opens
// the mail app with every part encoded, then logs it), a WhatsApp message (opens wa.me, then logs it) or a meeting
// (book one with a date and a time, or record a held one or a no-show). Cmd/Ctrl+Enter saves; Save says why while it
// cannot. A draft is kept per lead in this browser (the 50 most recent; cleared on save) and survives a reload; offline,
// saving waits and the text is kept.
export type ComposerMode = { type: ActivityType; meeting?: "book" | "held" | "no_show"; nonce: number };

function readDraft(leadId: string): { type: ActivityType; body: string; subject: string } | null {
  const parsed = readDraftRaw(leadId);
  if (!parsed || typeof parsed !== "object") return null;
  const d = parsed as Record<string, unknown>;
  if (!(ACTIVITY_TYPES as readonly unknown[]).includes(d.type) || typeof d.body !== "string" || typeof d.subject !== "string") return null;
  return { type: d.type as ActivityType, body: d.body.slice(0, BODY_MAX), subject: d.subject.slice(0, 200) };
}

const noopSubscribe = () => () => {};

function subscribeOnline(cb: () => void) {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
}

// Memoised: the lead page draws again on every tab switch (design 8.6: 100 ms).
export const Composer = memo(function Composer({ lead, mode, autoFocus = false, onSaved }: { lead: LeadDetail; mode: ComposerMode | null; autoFocus?: boolean; onSaved?: () => void }) {
  const t = useTranslations("Composer");
  const tOut = useTranslations("Outcomes");
  const mod = useModKey() ?? "Ctrl";
  const id = useId();
  const log = useLogActivity();
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // A Do not contact lead (design 7.1: Call, WhatsApp and Email hidden) gets no Email or WhatsApp kind: nothing here
  // may open the mail app or wa.me on it. A draft or a choice made before the lead became Do not contact reads as a note.
  const dnc = lead.lead_status === "do_not_contact";
  const [picked, setType] = useState<ActivityType>(mode?.type ?? "note");
  const type: ActivityType = dnc && (picked === "email" || picked === "whatsapp") ? "note" : picked;
  const [body, setBody] = useState("");
  const [subject, setSubject] = useState("");
  const [outcome, setOutcome] = useState<CallOutcome | null>(null);
  const [meeting, setMeeting] = useState<"book" | "held" | "no_show">(mode?.meeting ?? "book");
  const [follow, setFollow] = useState<FollowUp>(noFollowUp);
  const [numberIndex, setNumberIndex] = useState(0);
  const [emailIndex, setEmailIndex] = useState(0);
  const [contactId, setContactId] = useState<string>("");
  const [saving, setSaving] = useState(false);
  // Day 5b (design 7.9): the deal an entry is about. Undefined: the default (the newest open deal); null: none.
  const hasOpenDeal = (lead.deals?.open_count ?? 0) > 0;
  const leadDeals = useLeadDeals(lead.id, hasOpenDeal);
  const openDeals = useMemo(() => (leadDeals.data ?? []).filter((d) => d.status === "open"), [leadDeals.data]);
  const [dealChoice, setDealChoice] = useState<string | null | undefined>(undefined);
  const dealId = dealChoice === undefined ? (openDeals[0]?.id ?? null) : openDeals.some((d) => d.id === dealChoice) ? dealChoice : null;
  const [now] = useState(() => new Date());
  const viewerZone = useSyncExternalStore(noopSubscribe, () => browserZone() ?? "Europe/Paris", () => "Europe/Paris");

  const numbers = useMemo(() => leadNumbers(lead).filter((n) => !n.wrong), [lead]);
  const whatsappNumbers = useMemo(
    () => numbers.map((n) => ({ ...n, href: whatsappHref(n.number, lead.country) })).filter((n) => n.href),
    [numbers, lead.country],
  );
  const emails = useMemo(() => leadEmails(lead), [lead]);
  const ownerName = lead.owner ? personName(lead.owner) || null : null;

  // The draft for this lead, once in the browser (storage is not readable on the server): adjusted during render,
  // React's pattern for state that follows something outside it.
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const [draftFor, setDraftFor] = useState<string | null>(null);
  if (mounted && draftFor !== lead.id) {
    setDraftFor(lead.id);
    const d = readDraft(lead.id);
    if (d) {
      setType(d.type);
      setBody(d.body);
      setSubject(d.subject);
    }
  }
  const restored = draftFor === lead.id;

  // Kept as it is typed (a short pause first), so a reload or a crash does not lose it.
  useEffect(() => {
    if (!restored) return;
    const timer = window.setTimeout(() => writeDraft(lead.id, { type, body, subject }), 300);
    return () => window.clearTimeout(timer);
  }, [restored, lead.id, type, body, subject]);

  // A quick action (Note, Meeting) switches the composer (during render, when the request changes) and puts the
  // cursor in it (after the commit). Starts from null so a composer mounted with a request (the phone sheet) applies it
  // too, after the draft restore above: the quick action's kind wins over the draft's, the draft's text stays, and
  // Book a meeting gets its 10:00 default.
  const [seenMode, setSeenMode] = useState<ComposerMode | null>(null);
  if (mode !== seenMode) {
    setSeenMode(mode);
    if (mode) {
      setType(mode.type);
      if (mode.meeting) setMeeting(mode.meeting);
      if (mode.type === "meeting" && (mode.meeting ?? "book") === "book") setFollow({ date: null, time: "10:00" });
    }
  }
  useEffect(() => {
    if (!mode) return;
    requestAnimationFrame(() => (mode.type === "meeting" ? formRef.current?.querySelector<HTMLElement>('[data-meeting-kind] [aria-pressed="true"]') : bodyRef.current)?.focus());
  }, [mode]);

  useEffect(() => {
    if (autoFocus) bodyRef.current?.focus();
  }, [autoFocus]);

  const pickOutcome = (o: CallOutcome) => {
    setOutcome(o);
    const r = followUpRule("call", o);
    if (r === "date_or_time") setFollow({ date: nextWorkingDate(new Date(), lead.call_zone_key ?? "Europe/Paris"), time: null });
    else if (r === "time") setFollow({ date: nextWorkingDate(new Date(), lead.call_zone_key ?? "Europe/Paris"), time: "10:00" });
    else setFollow(noFollowUp);
  };

  const switchType = (next: ActivityType) => {
    setType(next);
    setOutcome(null);
    setFollow(next === "meeting" && meeting === "book" ? { date: null, time: "10:00" } : noFollowUp);
  };

  const entryOutcome: Outcome | null =
    type === "call" ? outcome : type === "email" || type === "whatsapp" ? "sent" : type === "meeting" && meeting !== "book" ? meeting : null;
  const rule = type === "meeting" && meeting === "book" ? "time" : followUpRule(type, entryOutcome);
  const length = textLength(body);
  const number = numbers[numberIndex] ?? null;
  const waNumber = whatsappNumbers[numberIndex] ?? whatsappNumbers[0] ?? null;
  const email = emails[emailIndex] ?? null;
  const emailBody = subject.trim() ? `${t("subjectLine", { subject: subject.trim() })}\n\n${body}`.trim() : body;

  // Why Save cannot run yet (shown next to it), or null.
  let reason: string | null = null;
  if (!online) reason = t("offline");
  else if (length > BODY_MAX) reason = t("tooLong");
  else if (UNSAFE_TEXT.test(body)) reason = t("badChars");
  else if (type === "note" && !body.trim()) reason = t("needText");
  else if (type === "call" && !outcome) reason = t("needOutcome");
  else if (type === "call" && outcome === "wrong_number" && !number) reason = t("needNumber");
  else if (type === "email" && !email) reason = t("needEmail");
  else if (type === "whatsapp" && !waNumber) reason = t("needWhatsapp");
  else if (rule !== "none" && !followUpReady(rule, follow)) reason = rule === "time" ? t("needTime") : t("needDate");
  const ready = !reason && !saving;

  const save = async () => {
    if (!ready) return;
    setSaving(true);
    const chosenContact =
      type === "call" ? (number?.contactId ?? null) : type === "whatsapp" ? (waNumber?.contactId ?? null) : type === "email" ? (email?.contactId ?? null) : contactId || null;
    const contactName =
      type === "call" ? number?.contactName : type === "whatsapp" ? waNumber?.contactName : type === "email" ? email?.contactName : lead.contacts.find((c) => c.id === contactId) ? personName(lead.contacts.find((c) => c.id === contactId)!) : null;
    const res = await log({
      input: {
        leadId: lead.id,
        type,
        outcome: entryOutcome,
        body: type === "email" ? emailBody : body,
        contactId: chosenContact,
        dialled: type === "call" && number ? number.dialled : null,
        ...(rule === "none" ? { followUpDate: null, followUpAt: null } : followUpArgs(follow, viewerZone)),
        leadName: lead.name,
        dealId,
      },
      preview: { contact_name: contactName ?? null },
      ownerName,
    });
    setSaving(false);
    if (res.ok) {
      setBody("");
      setSubject("");
      setOutcome(null);
      setFollow(type === "meeting" && meeting === "book" ? { date: null, time: "10:00" } : noFollowUp);
      writeDraft(lead.id, null);
      onSaved?.();
    }
  };

  const kinds: ActivityType[] = dnc ? ["note", "call", "meeting"] : ["note", "call", "email", "whatsapp", "meeting"];
  const reasonId = `${id}-reason`;
  const saveHint = (
    <span className="ml-1 hidden gap-1 sm:inline-flex" aria-hidden="true">
      <Kbd className="border-transparent bg-primary-foreground/15 text-primary-foreground">{mod}</Kbd>
      <Kbd className="border-transparent bg-primary-foreground/15 text-primary-foreground">↩</Kbd>
    </span>
  );

  return (
    <form noValidate
      ref={formRef}
      aria-label={t("label")}
      className="flex min-w-0 flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (type === "email" || type === "whatsapp") return;
        void save();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          if (type === "email" || type === "whatsapp") formRef.current?.querySelector<HTMLAnchorElement>("a[data-send]")?.click();
          else void save();
          return;
        }
        // Outcome keys while the focus is in the composer but not in a field (by key position: AZERTY-safe).
        if (type === "call" && !isTyping(e.target) && !e.nativeEvent.isComposing) {
          const o = outcomeForKey(e.nativeEvent);
          if (o) {
            e.preventDefault();
            pickOutcome(o);
          }
        }
      }}
    >
      {/* Five equal segments (three on a Do not contact lead) with an icon and a short label (like the dock), so French
          fits the rail too. */}
      <div role="group" aria-label={t("kindLabel")} className={cn("grid gap-0.5 rounded-md bg-muted p-1", dnc ? "grid-cols-3" : "grid-cols-5")}>
        {kinds.map((k) => {
          const Icon = typeIcon[k];
          return (
            <button
              key={k}
              type="button"
              aria-pressed={type === k}
              onClick={() => switchType(k)}
              className={cn(
                "flex min-h-12 min-w-0 flex-col items-center justify-center gap-0.5 rounded-[10px] px-1 text-[0.6875rem] leading-tight transition-[background-color,color,transform,scale] duration-150 active:scale-[0.97]",
                type === k ? "bg-pill text-foreground shadow-[0_1px_3px_rgb(14_14_16/0.12)]" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon aria-hidden="true" strokeWidth={1.75} className="size-4" />
              <span className="max-w-full text-center break-words">{t(`types.${k}`)}</span>
            </button>
          );
        })}
      </div>

      {type === "call" ? (
        <>
          {numbers.length > 1 ? (
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-bold">{t("number")}</span>
              <Select value={String(numberIndex)} onChange={(e) => setNumberIndex(Number(e.target.value))}>
                {numbers.map((n, i) => (
                  <option key={n.number + i} value={i}>
                    {n.contactName ? `${n.number} · ${n.contactName}` : n.number}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
          <OutcomePad value={outcome} onChange={pickOutcome} disabled={{ wrong_number: !number }} />
          {outcome === "do_not_contact" ? <p className="text-sm text-muted-foreground">{tOut("confirmDnc")}</p> : null}
        </>
      ) : null}

      {type === "email" ? (
        <>
          {emails.length > 1 ? (
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-bold">{t("to")}</span>
              <Select value={String(emailIndex)} onChange={(e) => setEmailIndex(Number(e.target.value))}>
                {emails.map((m, i) => (
                  <option key={m.address + i} value={i}>
                    {m.contactName ? `${m.address} · ${m.contactName}` : m.address}
                  </option>
                ))}
              </Select>
            </label>
          ) : email ? (
            <p className="text-sm">
              <span className="text-muted-foreground">{t("to")} </span>
              <span className="break-all">{email.address}</span>
            </p>
          ) : null}
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-bold">{t("subject")}</span>
            <Input name="subject" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} autoComplete="off" />
          </label>
        </>
      ) : null}

      {type === "whatsapp" && whatsappNumbers.length > 1 ? (
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-bold">{t("number")}</span>
          <Select value={String(numberIndex)} onChange={(e) => setNumberIndex(Number(e.target.value))}>
            {whatsappNumbers.map((n, i) => (
              <option key={n.number + i} value={i}>
                {n.contactName ? `${n.number} · ${n.contactName}` : n.number}
              </option>
            ))}
          </Select>
        </label>
      ) : null}

      {type === "meeting" ? (
        <div role="group" aria-label={t("meetingKind")} data-meeting-kind className="flex flex-wrap gap-1.5">
          {(["book", "held", "no_show"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={meeting === m}
              onClick={() => {
                setMeeting(m);
                setFollow(m === "book" ? { date: null, time: "10:00" } : noFollowUp);
              }}
              className={cn(
                "min-h-11 rounded-md px-3 text-sm transition-[background-color,color,transform,scale] duration-150 active:scale-[0.97] sm:min-h-9",
                meeting === m ? "bg-primary text-primary-foreground" : "bg-muted text-foreground hover:brightness-95 dark:hover:brightness-125",
              )}
            >
              {m === "book" ? t("bookMeeting") : tOut(m)}
            </button>
          ))}
        </div>
      ) : null}

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-bold">{type === "email" ? t("emailBody") : t("noteLabel")}</span>
        <Textarea
          ref={bodyRef}
          name="body"
          autoComplete="off"
          value={body}
          dir="auto"
          placeholder={t(`placeholder.${type}`)}
          aria-describedby={`${id}-count ${reasonId}`}
          aria-invalid={length > BODY_MAX || UNSAFE_TEXT.test(body) || undefined}
          onChange={(e) => setBody(e.target.value)}
          className="text-sm"
        />
        <span id={`${id}-count`} className={cn("text-right font-mono text-xs text-muted-foreground", length > BODY_MAX && "text-status-red")}>
          {type === "email" && length > MAILTO_BODY_MAX
            ? t("mailCut", { max: MAILTO_BODY_MAX })
            : length >= BODY_COUNTER_FROM
              ? t("counter", { count: length, max: BODY_MAX })
              : null}
        </span>
      </label>

      {type !== "note" || body.trim() ? (
        type === "call" && outcome && rule !== "none" ? (
          <FollowUpPicker
            rule={rule}
            value={follow}
            onChange={setFollow}
            viewerZone={viewerZone}
            leadZoneKey={lead.call_zone_key ?? "Europe/Paris"}
            now={now}
            legend={rule === "time" ? tOut("meetingWhen") : undefined}
          />
        ) : type !== "call" && rule !== "none" ? (
          <FollowUpPicker
            rule={rule}
            value={follow}
            onChange={setFollow}
            viewerZone={viewerZone}
            leadZoneKey={lead.call_zone_key ?? "Europe/Paris"}
            now={now}
            legend={rule === "time" ? t("meetingWhen") : undefined}
          />
        ) : null
      ) : null}

      {(type === "note" || type === "meeting") && lead.contacts.length > 0 ? (
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-bold">{t("contact")}</span>
          <Select value={contactId} onChange={(e) => setContactId(e.target.value)}>
            <option value="">{t("noContact")}</option>
            {lead.contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {personName(c)}
              </option>
            ))}
          </Select>
        </label>
      ) : null}

      <ComposerDealChip deals={openDeals} value={dealId} onChange={setDealChoice} />

      <div className="flex flex-col gap-2">
        {type === "email" ? (
          ready && email ? (
            <a
              data-send
              href={mailtoHref(email.address, subject, body)}
              onClick={() => void save()}
              className={cn(buttonVariants({ variant: "neutral", width: "full" }))}
            >
              {t("openMailAndLog")}
              {saveHint}
            </a>
          ) : (
            <Button variant="neutral" width="full" aria-disabled aria-describedby={reasonId}>
              {t("openMailAndLog")}
            </Button>
          )
        ) : type === "whatsapp" ? (
          ready && waNumber?.href ? (
            <a
              data-send
              href={waNumber.href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => void save()}
              className={cn(buttonVariants({ variant: "neutral", width: "full" }))}
            >
              {t("openWhatsAppAndLog")}
              {saveHint}
            </a>
          ) : (
            <Button variant="neutral" width="full" aria-disabled aria-describedby={reasonId}>
              {t("openWhatsAppAndLog")}
            </Button>
          )
        ) : (
          <Button type="submit" variant="neutral" width="full" aria-disabled={!ready || undefined} aria-describedby={reasonId}>
            {saving ? t("saving") : type === "call" && outcome === "do_not_contact" ? tOut("confirmDncAction") : t("save")}
            {saveHint}
          </Button>
        )}
        <p id={reasonId} className="min-h-5 text-xs text-muted-foreground" aria-live="polite">
          {reason && (type !== "note" || body.length > 0 || !online) ? reason : null}
        </p>
      </div>
    </form>
  );
});
