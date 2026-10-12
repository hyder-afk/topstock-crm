"use client";

import { useId, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, phoneSheet } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { useToast } from "@/components/ui/toast";
import { fetchLead, leadKey } from "@/components/leads/use-leads";
import type { useDealActions } from "@/components/pipeline/use-pipeline";
import { DEAL_TITLE_MAX, UNSAFE_TITLE, fulfilments, type Fulfilment } from "@/lib/deals";
import { personName, type LeadPage, type TeamMember } from "@/lib/leads";
import { formatMoney, parseMoney } from "@/lib/money";
import { useModKey } from "@/lib/use-platform";
import { cn } from "@/lib/utils";

// The open-deal sheet (Day 5 design 7.6): from the board's New deal (N), Cmd+K "New deal", or the lead page. The lead
// (prefilled, or a search box over the leads: list_leads by name, 8 shown), what is being sold, the value, the expected
// close, the contact, how it ships (optional), the owner (managers and admins). Open deal (Cmd/Ctrl+Enter). A lead
// that already has an open deal says so first: "Open it" or "Open another". The toast's Undo removes the new deal
// (delete_deal inside the creator's 2 minutes, no code).
export function OpenDealSheet({
  open,
  initialLead,
  onClose,
  onOpened,
  onOpenExisting,
  actions,
  team,
  canAssign,
  meId,
}: {
  open: boolean;
  initialLead: { id: string; name: string } | null;
  onClose: () => void;
  onOpened: (dealId: string) => void;
  onOpenExisting: (dealId: string) => void;
  actions: ReturnType<typeof useDealActions>;
  team: TeamMember[];
  canAssign: boolean;
  meId: string;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : onClose())}>
      {open ? (
        <OpenDealForm
          initialLead={initialLead}
          onClose={onClose}
          onOpened={onOpened}
          onOpenExisting={onOpenExisting}
          actions={actions}
          team={team}
          canAssign={canAssign}
          meId={meId}
        />
      ) : null}
    </Dialog>
  );
}

function OpenDealForm({
  initialLead,
  onClose,
  onOpened,
  onOpenExisting,
  actions,
  team,
  canAssign,
  meId,
}: {
  initialLead: { id: string; name: string } | null;
  onClose: () => void;
  onOpened: (dealId: string) => void;
  onOpenExisting: (dealId: string) => void;
  actions: ReturnType<typeof useDealActions>;
  team: TeamMember[];
  canAssign: boolean;
  meId: string;
}) {
  const t = useTranslations("Deals.open");
  const tD = useTranslations("Deals");
  const tF = useTranslations("Fulfilment");
  const tStage = useTranslations("Stages");
  const tHint = useTranslations("Errors.hint");
  const locale = useLocale();
  const toast = useToast();
  const mod = useModKey() ?? "Ctrl";
  const id = useId();
  const [lead, setLead] = useState(initialLead);
  const [search, setSearch] = useState("");
  const [title, setTitle] = useState("");
  const [valueText, setValueText] = useState("");
  const [close, setClose] = useState("");
  const [contactId, setContactId] = useState("");
  const [ships, setShips] = useState<Fulfilment | "">("");
  const [ownerId, setOwnerId] = useState(meId);
  const [confirmAnother, setConfirmAnother] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tried, setTried] = useState(false);

  const q = search.trim();
  const results = useQuery({
    queryKey: ["lead-search", q],
    queryFn: async () => {
      const res = await fetch(`/api/leads?${new URLSearchParams({ q, sort: "name" })}`, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(String(res.status));
      return ((await res.json()) as LeadPage).rows.slice(0, 8);
    },
    enabled: !lead && q.length >= 2,
    staleTime: 30_000,
  });
  const detail = useQuery({ queryKey: leadKey(lead?.id ?? "none"), queryFn: () => fetchLead(lead!.id), enabled: !!lead, staleTime: 30_000 });
  const existing = detail.data?.deals?.latest_open ?? null;
  const cannotOpen = detail.data ? detail.data.can_open_deal === false : false;

  const value = valueText.trim() ? parseMoney(valueText, locale) : null;
  const valueBad = valueText.trim() !== "" && value === null;
  const titleBad = Array.from(title.trim()).length > DEAL_TITLE_MAX || UNSAFE_TITLE.test(title);
  const mustConfirm = !!existing && !confirmAnother;

  const submit = async () => {
    setTried(true);
    if (!lead || valueBad || titleBad || saving || cannotOpen || mustConfirm) return;
    setSaving(true);
    const r = await actions.open({
      leadId: lead.id,
      title: title.trim() || null,
      value,
      expectedClose: close || null,
      fulfilment: ships || null,
      contactId: contactId || null,
      ownerId: canAssign && ownerId !== meId ? ownerId : null,
    });
    setSaving(false);
    if (!r) return;
    toast.show(tD("toast.opened", { stage: tStage("lead") }), { label: tD("menu.undo"), run: () => void actions.remove(r.deal) }, { duration: 10_000 });
    onOpened(r.deal.id);
  };

  return (
    <DialogContent className={cn(phoneSheet, "max-h-[calc(100dvh-24px)] overflow-y-auto sm:w-[min(520px,calc(100%-32px))]")}>
      <form
        noValidate
        className="flex flex-col gap-5 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <div className="flex flex-col gap-1.5">
          <DialogTitle className="text-xl font-bold tracking-[-0.03em]">{t("title")}</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">{t("body")}</DialogDescription>
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor={`${id}-lead`} className="text-sm font-bold">
            {t("lead")}
          </label>
          {lead ? (
            <div className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-border px-3">
              <span id={`${id}-lead`} className="min-w-0 truncate font-bold">
                {lead.name}
              </span>
              {!initialLead ? (
                <Button variant="link" className="min-h-11 text-sm sm:min-h-9" onClick={() => setLead(null)}>
                  {t("change")}
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <Input
                id={`${id}-lead`}
                role="combobox"
                aria-expanded={results.data ? results.data.length > 0 : false}
                aria-controls={`${id}-results`}
                aria-autocomplete="list"
                autoComplete="off"
                placeholder={t("leadPlaceholder")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    document.getElementById(`${id}-results`)?.querySelector<HTMLElement>("[role=option]")?.focus();
                  }
                }}
                aria-invalid={tried && !lead ? true : undefined}
              />
              <ul id={`${id}-results`} role="listbox" aria-label={t("lead")} className="flex flex-col">
                {results.isFetching && !results.data ? <li className="px-3 py-2 text-sm text-muted-foreground">{t("searching")}</li> : null}
                {results.isError ? <li className="px-3 py-2 text-sm text-status-red">{t("searchFailed")}</li> : null}
                {results.data && results.data.length === 0 ? <li className="px-3 py-2 text-sm text-muted-foreground">{t("noLeads")}</li> : null}
                {results.data?.map((r, i, all) => (
                  <li
                    key={r.id}
                    role="option"
                    aria-selected={false}
                    tabIndex={-1}
                    onClick={() => setLead({ id: r.id, name: r.name })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setLead({ id: r.id, name: r.name });
                      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                        e.preventDefault();
                        const items = e.currentTarget.parentElement?.querySelectorAll<HTMLElement>("[role=option]");
                        items?.[(i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
                      }
                    }}
                    className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-md px-3 text-sm outline-none hover:bg-muted focus:bg-muted"
                  >
                    <span className="min-w-0 truncate font-bold">{r.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{[r.city, r.country].filter(Boolean).join(" · ")}</span>
                  </li>
                ))}
              </ul>
              {tried && !lead ? <p className="text-sm text-status-red">{t("leadFirst")}</p> : null}
            </div>
          )}
          {cannotOpen ? (
            <p role="alert" className="text-sm text-status-red">
              {detail.data?.lead_status === "do_not_contact" ? tHint("dnc") : tHint("lead_required")}
            </p>
          ) : null}
          {existing && !confirmAnother ? (
            <div role="status" className="flex flex-col gap-2 rounded-md bg-muted p-3 text-sm">
              <p>{t("existing", { title: existing.title ?? tD("untitled"), stage: tStage(existing.stage) })}</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="neutral" className="min-h-11 sm:min-h-9" onClick={() => onOpenExisting(existing.id)}>
                  {t("openIt")}
                </Button>
                <Button variant="quiet" className="min-h-11 sm:min-h-9" onClick={() => setConfirmAnother(true)}>
                  {t("openAnother")}
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor={`${id}-title`} className="text-sm font-bold">
            {tD("fields.title")}
          </label>
          <Input id={`${id}-title`} value={title} dir="auto" autoComplete="off" placeholder={tD("fields.titlePlaceholder")} onChange={(e) => setTitle(e.target.value)} aria-invalid={titleBad || undefined} aria-describedby={`${id}-title-err`} />
          <p id={`${id}-title-err`} className="min-h-5 text-sm text-status-red">
            {titleBad ? tHint("deal_title") : null}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <label htmlFor={`${id}-value`} className="text-sm font-bold">
              {tD("fields.value")}
            </label>
            <Input id={`${id}-value`} inputMode="decimal" autoComplete="off" value={valueText} onChange={(e) => setValueText(e.target.value)} aria-invalid={valueBad || undefined} aria-describedby={`${id}-value-err`} className="font-mono" />
            <p id={`${id}-value-err`} className="min-h-5 text-sm text-status-red">
              {valueBad ? tD("edit.valueInvalid") : value ? <span className="text-muted-foreground">{formatMoney(value, locale, { cents: true })}</span> : null}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor={`${id}-close`} className="text-sm font-bold">
              {tD("fields.expectedClose")}
            </label>
            <input id={`${id}-close`} type="date" value={close} onChange={(e) => setClose(e.target.value)} className="min-h-11 rounded-md border border-border bg-background px-3 font-mono text-sm text-foreground" />
          </div>
        </div>
        {detail.data && detail.data.contacts.length > 0 ? (
          <div className="flex flex-col gap-2">
            <label htmlFor={`${id}-contact`} className="text-sm font-bold">
              {tD("fields.contact")}
            </label>
            <select id={`${id}-contact`} value={contactId} onChange={(e) => setContactId(e.target.value)} className="min-h-11 rounded-md border border-border bg-background px-3 text-sm text-foreground">
              <option value="">{tD("fields.noContact")}</option>
              {detail.data.contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {personName(c)}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="flex flex-col gap-2">
          <label htmlFor={`${id}-ships`} className="text-sm font-bold">
            {tD("fields.fulfilment")}
          </label>
          <select id={`${id}-ships`} value={ships} onChange={(e) => setShips(e.target.value as Fulfilment | "")} className="min-h-11 rounded-md border border-border bg-background px-3 text-sm text-foreground">
            <option value="">{tF("undecided")}</option>
            {fulfilments.map((f) => (
              <option key={f} value={f}>
                {tF(`${f}.title`)}
              </option>
            ))}
          </select>
        </div>
        {canAssign ? (
          <div className="flex flex-col gap-2">
            <label htmlFor={`${id}-owner`} className="text-sm font-bold">
              {tD("fields.owner")}
            </label>
            <select id={`${id}-owner`} value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className="min-h-11 rounded-md border border-border bg-background px-3 text-sm text-foreground">
              {team.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id === meId ? t("ownerMe") : personName(m)}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button variant="quiet" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button type="submit" variant="neutral" aria-disabled={!lead || saving || cannotOpen || mustConfirm || undefined}>
            {t("submit")}
            <span className="ml-1 hidden gap-1 sm:inline-flex" aria-hidden="true">
              <Kbd className="border-transparent bg-primary-foreground/15 text-primary-foreground">{mod}</Kbd>
              <Kbd className="border-transparent bg-primary-foreground/15 text-primary-foreground">↩</Kbd>
            </span>
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}
