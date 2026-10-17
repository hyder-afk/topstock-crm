"use client";

import { useState } from "react";
import Link from "next/link";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowUpRight, Building2, Mail, Pencil, Phone, Plus, X } from "lucide-react";
import { addContact, updateContact, updateLead } from "@/app/(app)/leads/actions";
import { Button, buttonVariants } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useCallPanel } from "@/components/activity/call-panel";
import { prefetchLead } from "@/components/activity/use-activities";
import { callTarget } from "@/components/lead/lead-data";
import { StatusMenu } from "@/components/lead/status-menu";
import { ContactForm, contactToValues } from "@/components/leads/contact-form";
import { LeadForm, leadToValues } from "@/components/leads/lead-form";
import { StatusBadge } from "@/components/leads/status-badge";
import { leadKey, rowBefore, useLead, useLeadChanges } from "@/components/leads/use-leads";
import { countryName } from "@/lib/countries";
import { mailHref, personName, telHref, type LeadDetail, type TeamMember } from "@/lib/leads";
import { callHref } from "@/lib/phone";
import { cn } from "@/lib/utils";

// Compact actions so Call, Email, Set status and Edit fit one row in the preview panel.
const compact = "min-h-11 px-3 text-sm sm:min-h-10";

export function LeadPreview({
  id,
  team,
  canAssign,
  onClose,
  onOpenPage,
}: {
  id: string;
  team: TeamMember[];
  canAssign: boolean;
  onClose: () => void;
  onOpenPage?: () => void;
}) {
  const t = useTranslations("Leads.preview");
  const tLeads = useTranslations("Leads");
  const { data: lead, isPending, isError, refetch } = useLead(id);

  const header = (
    <div className="flex items-center lg:absolute lg:top-3 lg:right-3">
      <Button variant="link" onClick={onClose} className="gap-1 lg:hidden">
        <ArrowLeft aria-hidden="true" strokeWidth={1.75} className="size-4" />
        {t("back")}
      </Button>
      <button
        type="button"
        onClick={onClose}
        aria-label={t("close")}
        className="hidden size-9 place-items-center rounded-md text-muted-foreground transition-[color,transform,scale] duration-150 hover:text-foreground active:scale-[0.97] lg:grid"
      >
        <X aria-hidden="true" strokeWidth={1.75} className="size-5" />
      </button>
    </div>
  );

  if (isPending) return <div className="flex flex-col gap-4">{header}<PreviewSkeleton /></div>;
  if (isError)
    return (
      <div className="flex flex-col gap-4">
        {header}
        <div role="alert" className="flex flex-col items-start gap-3">
          <h2 className="text-lg font-bold">{t("errorTitle")}</h2>
          <Button variant="quiet" onClick={() => void refetch()}>
            {tLeads("retry")}
          </Button>
        </div>
      </div>
    );
  if (!lead)
    return (
      <div className="flex flex-col gap-4">
        {header}
        <p className="text-muted-foreground">{t("notFound")}</p>
      </div>
    );
  return <LeadDetailView key={lead.id} lead={lead} team={team} canAssign={canAssign} header={header} onOpenPage={onOpenPage} />;
}

function LeadDetailView({
  lead,
  team,
  canAssign,
  header,
  onOpenPage,
}: {
  lead: LeadDetail;
  team: TeamMember[];
  canAssign: boolean;
  header: React.ReactNode;
  onOpenPage?: () => void;
}) {
  const t = useTranslations("Leads.preview");
  const tLeads = useTranslations("Leads");
  const tForm = useTranslations("Leads.form");
  const tContact = useTranslations("Leads.contactForm");
  const format = useFormatter();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { changeStatus } = useLeadChanges(team);
  const { startCall } = useCallPanel();
  const tPage = useTranslations("LeadPage");
  const [editing, setEditing] = useState(false);
  const [contactEdit, setContactEdit] = useState<string | "new" | null>(null);
  // Hover or focus on Open lead warms the page in full: the lead and its first timeline page into the query cache, and
  // the server-rendered page itself (Link prefetch={true}, kept by the router for 5 minutes), so the click draws from
  // memory without a server round trip. Before that, the default prefetch (down to the page's loading skeleton).
  const [warm, setWarm] = useState(false);
  const warmUp = () => {
    prefetchLead(queryClient, lead.id);
    setWarm(true);
    // The page's code is loaded and run now, not on the click (the router's prefetch downloads it but runs it later).
    void import("@/components/lead/lead-page");
  };

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: leadKey(lead.id) });
    void queryClient.invalidateQueries({ queryKey: ["leads"] });
  };
  const ownerName = lead.owner ? personName(lead.owner) || tLeads("noName") : "";
  const before = rowBefore({
    id: lead.id,
    lead_status: lead.lead_status,
    owner_id: lead.owner?.id ?? null,
    owner_first_name: lead.owner?.first_name ?? null,
    owner_last_name: lead.owner?.last_name ?? null,
  });

  const notSet = <span className="text-muted-foreground">{t("notSet")}</span>;
  const details: { label: string; value: React.ReactNode }[] = [
    { label: t("owner"), value: ownerName || <span className="text-muted-foreground">{tLeads("unassigned")}</span> },
    {
      label: t("phone"),
      value: lead.phone ? (
        <a href={telHref(lead.phone)} className="font-mono text-sm underline-offset-4 hover:underline">
          {lead.phone}
        </a>
      ) : (
        notSet
      ),
    },
    {
      label: t("email2"),
      value: lead.email ? (
        <a href={mailHref(lead.email)} className="break-all underline-offset-4 hover:underline">
          {lead.email}
        </a>
      ) : (
        notSet
      ),
    },
    { label: t("city"), value: lead.city || notSet },
    { label: t("country"), value: lead.country ? countryName(lead.country, locale) : notSet },
    {
      label: t("lastActivity"),
      value: lead.last_activity_at ? (
        <time dateTime={lead.last_activity_at}>
          {format.relativeTime(new Date(lead.last_activity_at))}<span className="sr-only"> ({format.dateTime(new Date(lead.last_activity_at), { dateStyle: "long", timeStyle: "short" })})</span>
        </time>
      ) : (
        <span className="text-muted-foreground">{tLeads("never")}</span>
      ),
    },
    {
      label: t("added"),
      value: <time dateTime={lead.created_at}>{format.dateTime(new Date(lead.created_at), { dateStyle: "medium" })}</time>,
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      {header}
      <div className="flex items-start gap-3 lg:pr-10">
        <span className="grid size-11 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          <Building2 aria-hidden="true" strokeWidth={1.75} className="size-[22px]" />
        </span>
        <div className="flex min-w-0 flex-col gap-1.5">
          <h2 className="text-xl leading-tight font-bold text-balance break-words">{lead.name}</h2>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={lead.lead_status} />
            <span className="text-sm text-muted-foreground">{ownerName || tLeads("unassigned")}</span>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {/* Day 4b: the full lead page (timeline, composer, tasks), warmed on hover. */}
        <Link
          href={`/leads/${lead.id}`}
          data-open-lead=""
          prefetch={warm ? true : null}
          onClick={onOpenPage}
          onPointerEnter={warmUp}
          onFocus={warmUp}
          className={cn(buttonVariants({ variant: "neutral" }), compact)}
        >
          {tPage("openLead")}
          <ArrowUpRight aria-hidden="true" strokeWidth={2} className="size-4" />
        </Link>
        {lead.phone && !lead.phone_wrong_at && lead.lead_status !== "do_not_contact" ? (
          <a
            href={callHref(lead.phone, lead.country)}
            onClick={(e) =>
              startCall(callTarget(lead, { number: lead.phone as string, dialled: "lead", contactId: null, contactName: null, wrong: false }), e.currentTarget)
            }
            className={cn(buttonVariants({ variant: "brand" }), compact)}
          >
            <Phone aria-hidden="true" strokeWidth={2} className="size-4" />
            {t("call")}
          </a>
        ) : null}
        {lead.email && lead.lead_status !== "do_not_contact" ? (
          <a href={mailHref(lead.email)} className={cn(buttonVariants({ variant: "quiet" }), compact)}>
            <Mail aria-hidden="true" strokeWidth={1.75} className="size-4" />
            {t("email")}
          </a>
        ) : null}
        {lead.can_edit ? (
          <>
            <StatusMenu
              variant="button"
              status={lead.lead_status}
              callZoneKey={lead.call_zone_key ?? "Europe/Paris"}
              onChange={(status, returnAt) => void changeStatus([before], status, returnAt)}
            />
            {!editing ? (
              <Button variant="quiet" className={compact} onClick={() => setEditing(true)}>
                <Pencil aria-hidden="true" strokeWidth={1.75} className="size-4" />
                {t("edit")}
              </Button>
            ) : null}
          </>
        ) : null}
      </div>

      {!lead.can_edit ? (
        <p className="text-sm text-muted-foreground">
          {ownerName ? t("readOnly", { owner: ownerName }) : t("readOnlyUnowned")}
        </p>
      ) : null}

      {editing ? (
        <section aria-label={tForm("editTitle")} className="rounded-md border border-border p-4">
          <LeadForm
            initial={leadToValues(lead)}
            team={team}
            canAssign={canAssign}
            submitLabel={tForm("save")}
            onCancel={() => setEditing(false)}
            onSubmit={async (values) => {
              const res = await updateLead(lead.id, values);
              if (!res.ok) return res.error;
              setEditing(false);
              refresh();
              toast.show(tForm("saved"));
              return null;
            }}
          />
        </section>
      ) : (
        <section aria-labelledby={`details-${lead.id}`} className="flex flex-col gap-3">
          <h3 id={`details-${lead.id}`} className="text-sm font-bold text-muted-foreground">
            {t("details")}
          </h3>
          <dl className="grid grid-cols-[minmax(96px,auto)_1fr] gap-x-4 gap-y-2.5 text-sm">
            {details.map((d) => (
              <div key={d.label} className="contents">
                <dt className="text-muted-foreground">{d.label}</dt>
                <dd className="min-w-0 break-words">{d.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <section aria-labelledby={`contacts-${lead.id}`} className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h3 id={`contacts-${lead.id}`} className="text-sm font-bold text-muted-foreground">
            {t("contactsTitle")} <span className="font-mono">{lead.contacts.length}</span>
          </h3>
          {lead.can_edit && contactEdit !== "new" ? (
            <Button variant="link" onClick={() => setContactEdit("new")} className="gap-1">
              <Plus aria-hidden="true" strokeWidth={1.75} className="size-4" />
              {t("addContact")}
            </Button>
          ) : null}
        </div>
        {contactEdit === "new" ? (
          <ContactForm
            initial={contactToValues()}
            onCancel={() => setContactEdit(null)}
            onSubmit={async (values) => {
              const res = await addContact(lead.id, values);
              if (!res.ok) return res.error;
              setContactEdit(null);
              refresh();
              toast.show(tContact("added"));
              return null;
            }}
          />
        ) : null}
        {lead.contacts.length === 0 && contactEdit !== "new" ? (
          <p className="text-sm text-muted-foreground">{t("noContacts")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {lead.contacts.map((c) =>
              contactEdit === c.id ? (
                <li key={c.id} className="p-2">
                  <ContactForm
                    initial={contactToValues(c)}
                    onCancel={() => setContactEdit(null)}
                    onSubmit={async (values) => {
                      const res = await updateContact(c.id, values);
                      if (!res.ok) return res.error;
                      setContactEdit(null);
                      refresh();
                      toast.show(tContact("saved"));
                      return null;
                    }}
                  />
                </li>
              ) : (
                <li key={c.id} className="flex items-start gap-3 px-4 py-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-sm">
                    <span className="font-bold break-words">{personName(c)}</span>
                    {c.title ? <span className="text-muted-foreground">{c.title}</span> : null}
                    <span className={cn("flex flex-wrap gap-x-4 gap-y-1", !c.phone && !c.email && "hidden")}>
                      {c.phone ? (
                        <a href={telHref(c.phone)} className="font-mono underline-offset-4 hover:underline">
                          {c.phone}
                        </a>
                      ) : null}
                      {c.email ? (
                        <a href={mailHref(c.email)} className="break-all underline-offset-4 hover:underline">
                          {c.email}
                        </a>
                      ) : null}
                    </span>
                  </div>
                  {lead.can_edit ? (
                    <button
                      type="button"
                      onClick={() => setContactEdit(c.id)}
                      aria-label={t("editContact", { name: personName(c) })}
                      className="grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground transition-[color,transform,scale] duration-150 hover:text-foreground active:scale-[0.97] sm:size-9"
                    >
                      <Pencil aria-hidden="true" strokeWidth={1.75} className="size-4" />
                    </button>
                  ) : null}
                </li>
              ),
            )}
          </ul>
        )}
      </section>
    </div>
  );
}

export function PreviewSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-6">
      <div className="flex items-start gap-3">
        <div className="size-11 rounded-md bg-muted motion-safe:animate-pulse" />
        <div className="flex flex-1 flex-col gap-2">
          <div className="h-6 w-3/4 rounded-sm bg-muted motion-safe:animate-pulse" />
          <div className="h-5 w-1/2 rounded-sm bg-muted motion-safe:animate-pulse" />
        </div>
      </div>
      <div className="flex gap-2">
        <div className="h-11 w-24 rounded-md bg-muted motion-safe:animate-pulse" />
        <div className="h-11 w-24 rounded-md bg-muted motion-safe:animate-pulse" />
      </div>
      <div className="flex flex-col gap-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-5 w-full rounded-sm bg-muted motion-safe:animate-pulse" />
        ))}
      </div>
    </div>
  );
}
