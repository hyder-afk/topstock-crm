"use client";

import { memo } from "react";

import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Building2, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/leads/status-badge";
import { LocalTime, useClientNow } from "@/components/lead/local-time";
import { StatusMenu } from "@/components/lead/status-menu";
import { countryName } from "@/lib/countries";
import { personName, type LeadDetail, type LeadStatus, type TeamMember } from "@/lib/leads";
import type { TimelineEntry } from "@/lib/activities";

// The lead page header (Day 4 design 7.1): a 44 px tile, the name (h1, wraps), the status (a menu for people who may
// change the lead), the owner (a menu for managers and admins); then city · country · the lead's local time; then the
// next call, the latest call outcome and the tries in a row without reaching anyone.
// Memoised: the lead page draws again on every tab switch (design 8.6: 100 ms).
export const LeadHeader = memo(function LeadHeader({
  lead,
  team,
  canAssign,
  latestCall,
  onStatus,
  onOwner,
  onShowDetails,
}: {
  lead: LeadDetail;
  team: TeamMember[];
  canAssign: boolean;
  latestCall: TimelineEntry | null;
  onStatus: (status: LeadStatus, returnAt: string | null) => void;
  onOwner: (ownerId: string | null) => void;
  onShowDetails: (focus?: "timezone" | "country" | "next") => void;
}) {
  const t = useTranslations("LeadPage");
  const tLeads = useTranslations("Leads");
  const tOut = useTranslations("Outcomes");
  const format = useFormatter();
  const locale = useLocale();
  const now = useClientNow(60_000);
  const ownerName = lead.owner ? personName(lead.owner) || tLeads("noName") : null;
  const place = [lead.city, lead.country ? countryName(lead.country, locale) : null].filter(Boolean);
  const next = lead.next_action_at ? new Date(lead.next_action_at) : null;

  const facts: string[] = [];
  if (next && now && lead.lead_status !== "do_not_contact") {
    facts.push(next.getTime() <= now.getTime() ? t("nextCallDue", { when: format.relativeTime(next, now) }) : t("nextCall", { when: format.relativeTime(next, now) }));
  }
  if (latestCall?.outcome) facts.push(t("lastCall", { outcome: tOut(latestCall.outcome) }));
  if ((lead.attempts ?? 0) > 0) facts.push(t("attempts", { count: lead.attempts ?? 0 }));

  return (
    <div className="flex min-w-0 items-start gap-3">
      <span className="grid size-11 shrink-0 place-items-center rounded-md bg-card text-muted-foreground">
        <Building2 aria-hidden="true" strokeWidth={1.75} className="size-[22px]" />
      </span>
      <div className="flex min-w-0 flex-col gap-1.5">
        <h1 className="text-[22px] leading-7 font-bold break-words sm:text-3xl sm:leading-9">{lead.name}</h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {lead.can_edit ? (
            <StatusMenu status={lead.lead_status} callZoneKey={lead.call_zone_key ?? "Europe/Paris"} onChange={onStatus} />
          ) : (
            <StatusBadge status={lead.lead_status} />
          )}
          {canAssign ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={t("ownerMenu", { owner: ownerName ?? tLeads("unassigned") })}
                className="inline-flex min-h-11 items-center gap-1 rounded-sm text-sm text-muted-foreground transition-[color,transform,scale] duration-150 hover:text-foreground active:scale-[0.97] sm:min-h-0"
              >
                {ownerName ?? tLeads("unassigned")}
                <ChevronDown aria-hidden="true" strokeWidth={1.75} className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuRadioGroup value={lead.owner?.id ?? ""} onValueChange={(v) => {
                    // Radix reports the item already selected too: picking the current owner again changes nothing.
                    if ((v || null) !== (lead.owner?.id ?? null)) onOwner(v || null);
                  }}
                >
                  {team.map((m) => (
                    <DropdownMenuRadioItem key={m.id} value={m.id}>
                      {personName(m) || tLeads("noName")}
                    </DropdownMenuRadioItem>
                  ))}
                  <DropdownMenuRadioItem value="">{tLeads("unassigned")}</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <span className="text-sm text-muted-foreground">{ownerName ?? tLeads("unassigned")}</span>
          )}
        </div>
        {/* Place and local time: one line from tablet width, two lines on phones. */}
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
          {place.length ? <span className="max-sm:basis-full">{place.join(" · ")}</span> : null}
          {place.length ? <span aria-hidden="true" className="text-muted-foreground max-sm:hidden">·</span> : null}
          <LocalTime
            callZoneKey={lead.call_zone_key ?? "Europe/Paris"}
            country={lead.country}
            canSetZone={!!lead.can_set_timezone}
            onSetZone={() => onShowDetails("timezone")}
            onAddCountry={lead.can_edit ? () => onShowDetails("country") : null}
          />
        </p>
        {facts.length ? <p className="text-sm text-muted-foreground">{facts.join(" · ")}</p> : null}
        {/* Day 4c: a teammate has this lead on their queue screen right now (their claim's end, in the viewer's zone). */}
        {lead.worked_by && now && new Date(lead.worked_by.until).getTime() > now.getTime() ? (
          <p className="inline-flex items-center gap-1.5 text-sm">
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-status-amber" />
            {t("workedBy", {
              name: lead.worked_by.first_name || tLeads("noName"),
              time: format.dateTime(new Date(lead.worked_by.until), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
            })}
          </p>
        ) : null}
      </div>
    </div>
  );
});
