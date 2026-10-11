"use client";

import { useId, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { updateLead } from "@/app/(app)/leads/actions";
import { setLeadTimezone, setNextAction } from "@/app/(app)/leads/[id]/actions";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { refreshLead } from "@/components/activity/use-activities";
import { LeadForm, leadToValues } from "@/components/leads/lead-form";
import { Card, ContactsCard } from "@/components/lead/lead-cards";
import { countryName } from "@/lib/countries";
import { mailHref, personName, type LeadDetail, type TeamMember } from "@/lib/leads";
import { callHref } from "@/lib/phone";
import { addDays, localDate, primaryZone, spanEnds, zoneChoices, zoneCity, zoneName, zonedInstant } from "@/lib/timezones";

// The Details tab (Day 4 design 7.1): the Day 3a lead form for people who may change the lead (read-only facts for
// others); the calling zone (countries with several zones only, from a closed list: "Automatic: hours that suit the
// whole country" until one is picked); the next call date (at most 2 years ahead); when the lead was added and, for
// admins, the import it came from; the contacts.
const noopSubscribe = () => () => {};

export function DetailsTab({ lead, team, canAssign }: { lead: LeadDetail; team: TeamMember[]; canAssign: boolean }) {
  const t = useTranslations("LeadPage.details");
  const tPreview = useTranslations("Leads.preview");
  const tForm = useTranslations("Leads.form");
  const tLeads = useTranslations("Leads");
  const tErr = useTranslations("Errors");
  const format = useFormatter();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const toast = useToast();
  const id = useId();
  const [formKey, setFormKey] = useState(0);
  // Zone and country names come from the browser's Intl data, which can word them differently from the server's: shown
  // once in the browser only, so the first render matches the server's.
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const zoneLabel = (z: string) => (mounted ? `${zoneCity(z)} · ${zoneName(z, locale)}` : zoneCity(z));
  const choices = zoneChoices(lead.country);
  const key = lead.call_zone_key ?? "Europe/Paris";
  const zone = primaryZone(key);
  const ends = spanEnds(lead.country ?? "");
  const nextValue = lead.next_action_at
    ? `${localDate(zone, new Date(lead.next_action_at))}T${format.dateTime(new Date(lead.next_action_at), { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: zone })}`
    : "";
  const [next, setNext] = useState(nextValue);
  const today = localDate(zone, new Date());

  const saveZone = async (value: string) => {
    const res = await setLeadTimezone({ leadId: lead.id, timezone: value || null }).catch(() => ({ ok: false as const, error: "unavailable" as const }));
    if (!res.ok) {
      toast.show(tErr("hint" in res && res.hint ? `hint.${res.hint}` : res.error));
      return;
    }
    refreshLead(queryClient, lead.id);
    toast.show(t("zoneSaved"));
  };

  const saveNext = async (value: string | null) => {
    const at = value ? zonedInstant(value.slice(0, 10), value.slice(11, 16), zone).toISOString() : null;
    const res = await setNextAction({ leadId: lead.id, at }).catch(() => ({ ok: false as const, error: "unavailable" as const }));
    if (!res.ok) {
      toast.show(tErr("hint" in res && res.hint ? `hint.${res.hint}` : res.error));
      return;
    }
    if (!value) setNext("");
    refreshLead(queryClient, lead.id);
    toast.show(value ? t("nextSaved") : t("nextCleared"));
  };

  const facts: { label: string; value: React.ReactNode }[] = [
    { label: tPreview("owner"), value: lead.owner ? personName(lead.owner) || tLeads("noName") : tLeads("unassigned") },
    {
      label: tPreview("phone"),
      value: lead.phone ? (
        <a href={callHref(lead.phone, lead.country)} className="font-mono underline-offset-4 hover:underline" translate="no">
          {lead.phone}
        </a>
      ) : (
        tPreview("notSet")
      ),
    },
    {
      label: tPreview("email2"),
      value: lead.email ? (
        <a href={mailHref(lead.email)} className="break-all underline-offset-4 hover:underline">
          {lead.email}
        </a>
      ) : (
        tPreview("notSet")
      ),
    },
    { label: tPreview("city"), value: lead.city || tPreview("notSet") },
    { label: tPreview("country"), value: lead.country ? countryName(lead.country, locale) : tPreview("notSet") },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card title={t("lead")}>
        {lead.can_edit && !mounted ? (
          // Country names and their order come from the browser's Intl data (it can differ from the server's): the form
          // is drawn in the browser only, with a placeholder of its shape first.
          <div aria-hidden="true" className="flex flex-col gap-4">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="flex flex-col gap-2">
                <div className="h-4 w-24 rounded-sm bg-muted motion-safe:animate-pulse" />
                <div className="h-11 rounded-md bg-muted motion-safe:animate-pulse" />
              </div>
            ))}
          </div>
        ) : lead.can_edit ? (
          <LeadForm
            key={formKey}
            initial={leadToValues(lead)}
            team={team}
            canAssign={canAssign}
            submitLabel={tForm("save")}
            onCancel={() => setFormKey((k) => k + 1)}
            onSubmit={async (values) => {
              const res = await updateLead(lead.id, values);
              if (!res.ok) return res.error;
              refreshLead(queryClient, lead.id);
              toast.show(tForm("saved"));
              return null;
            }}
          />
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {lead.owner ? tPreview("readOnly", { owner: personName(lead.owner) || tLeads("noName") }) : tPreview("readOnlyUnowned")}
            </p>
            <dl className="grid grid-cols-[minmax(96px,auto)_1fr] gap-x-4 gap-y-2.5 text-sm">
              {facts.map((f) => (
                <div key={f.label} className="contents">
                  <dt className="text-muted-foreground">{f.label}</dt>
                  <dd className="min-w-0 break-words">{f.value}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </Card>

      <Card title={t("calling")}>
        <div className="flex flex-col gap-4 text-sm">
          {choices ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-zone`} className="font-bold">
                {t("timezone")}
              </label>
              {lead.can_set_timezone ? (
                <Select
                  id={`${id}-zone`}
                  name="timezone"
                  data-focus="timezone"
                  aria-describedby={`${id}-zone-hint`}
                  value={lead.timezone ?? ""}
                  onChange={(e) => void saveZone(e.target.value)}
                >
                  <option value="">
                    {ends ? t("autoSpan", { from: zoneCity(ends[1]), to: zoneCity(ends[0]) }) : t("auto", { zone: zoneCity(key) })}
                  </option>
                  {choices.map((z) => (
                    <option key={z} value={z}>
                      {zoneLabel(z)}
                    </option>
                  ))}
                </Select>
              ) : (
                <span id={`${id}-zone`}>{lead.timezone ? zoneLabel(lead.timezone) : t("autoShort")}</span>
              )}
              <span id={`${id}-zone-hint`} className="text-xs text-muted-foreground">
                {t("timezoneHint")}
              </span>
            </div>
          ) : (
            <p>
              <span className="font-bold">{t("timezone")}</span>
              <span className="block text-muted-foreground">
                {lead.country ? zoneLabel(key) : t("noCountry")}
              </span>
            </p>
          )}

          {lead.can_edit ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-next`} className="font-bold">
                {t("nextCall")}
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  id={`${id}-next`}
                  name="next_action_at"
                  data-focus="next"
                  type="datetime-local"
                  value={next}
                  min={`${addDays(today, -365)}T00:00`}
                  max={`${addDays(today, 730)}T23:59`}
                  onChange={(e) => setNext(e.target.value)}
                  aria-describedby={`${id}-next-hint`}
                  className="min-h-11 rounded-md border border-border bg-background px-3 font-mono text-sm text-foreground"
                />
                <Button variant="neutral" className="min-h-11" aria-disabled={!next || next === nextValue || undefined} onClick={() => next && next !== nextValue && void saveNext(next)}>
                  {t("save")}
                </Button>
                {lead.next_action_at ? (
                  <Button variant="quiet" className="min-h-11" onClick={() => void saveNext(null)}>
                    {t("clear")}
                  </Button>
                ) : null}
              </div>
              <span id={`${id}-next-hint`} className="text-xs text-muted-foreground">
                {t("nextHint", { zone: zoneCity(zone) })}
              </span>
            </div>
          ) : lead.next_action_at ? (
            <p>
              <span className="font-bold">{t("nextCall")}</span>
              <span className="block">{format.dateTime(new Date(lead.next_action_at), { dateStyle: "medium", timeStyle: "short" })}</span>
            </p>
          ) : null}

          <dl className="grid grid-cols-[minmax(96px,auto)_1fr] gap-x-4 gap-y-2.5">
            <dt className="text-muted-foreground">{tPreview("added")}</dt>
            <dd>
              <time dateTime={lead.created_at}>{format.dateTime(new Date(lead.created_at), { dateStyle: "medium" })}</time>
            </dd>
            {lead.import ? (
              <>
                <dt className="text-muted-foreground">{t("import")}</dt>
                <dd className="min-w-0 break-words">
                  <Link href={`/leads?batch=${lead.import.id}`} className="underline-offset-4 hover:underline">
                    {t("fromImport", {
                      file: lead.import.filename,
                      date: format.dateTime(new Date(lead.import.created_at), { day: "numeric", month: "short" }),
                    })}
                  </Link>
                </dd>
              </>
            ) : null}
          </dl>
        </div>
      </Card>

      {/* From desktop width the contacts are in the rail beside every tab. */}
      <div className="lg:hidden">
        <ContactsCard lead={lead} readOnlyContact={false} />
      </div>
    </div>
  );
}
