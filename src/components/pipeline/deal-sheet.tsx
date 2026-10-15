"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { MoreHorizontal, Trash2, Copy, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { StageStepper } from "@/components/pipeline/stage-stepper";
import { fetchLead, leadKey } from "@/components/leads/use-leads";
import { lastUndoableMove, useDealActions } from "@/components/pipeline/use-pipeline";
import {
  DEAL_TITLE_MAX,
  UNSAFE_TITLE,
  dealPath,
  elapsedDays,
  fulfilments,
  reopenStage,
  type DealCard,
  type DealDetail,
  type Fulfilment,
  type StageKey,
  type UpdateField,
} from "@/lib/deals";
import { personName, type TeamMember } from "@/lib/leads";
import { formatMoney, moneyInputText, parseMoney } from "@/lib/money";
import { dealKey, fetchDealClient } from "@/lib/prefetch";
import { rememberFocus, returnFocus, type FocusReturn } from "@/lib/focus-return";
import { cn } from "@/lib/utils";

// The deal sheet (Day 5 design 7.6): ?deal=<id> (written with replaceState), so it deep-links from the board and the lead
// page. A 440 px sheet on the right from 1024 px wide, a full-height bottom sheet below. The lead (link), the title and
// value (inline edits), the stage stepper (the main way to move on a phone), the status line, the expected close (chips),
// the contact, how it ships, the owner (managers and admins), the path with undo pairs folded, the history, the last
// entries linked to the deal (never their text), and a ⋯ menu (copy link, delete). Closed deals are read-only ("Reopen
// to change the value"). An edit that meets a colleague's change asks Keep yours / Use theirs.
export type SheetFlows = {
  openWin: (card: DealCard) => void;
  openLose: (card: DealCard) => void;
  openReopen: (card: DealCard, stage: "lead" | "qualified" | "negotiations") => void;
  openDelete: (card: DealCard, done?: (ok: boolean) => void) => void;
  actions: ReturnType<typeof useDealActions>;
};

export function DealSheet({
  dealId,
  onClose,
  flows,
  team,
  canAssign,
}: {
  dealId: string | null;
  onClose: () => void;
  flows: SheetFlows;
  team: TeamMember[];
  canAssign: boolean;
}) {
  // Focus goes back where it was when the sheet opened (a card, a Deals tab row, the Summary card), or to that deal's
  // card or row when the opener is gone, else to the row now at the opener's place or the one before, else the card's
  // heading: never to <body> (a move can take the deal out of Home's Needs attention while the sheet is open). Read
  // before Radix moves focus into the sheet (its focus scope runs in an effect, after this layout effect).
  const opener = useRef<{ from: FocusReturn; id: string } | null>(null);
  useLayoutEffect(() => {
    if (dealId && opener.current?.id !== dealId) opener.current = { from: rememberFocus(document.activeElement), id: dealId };
  }, [dealId]);
  const onCloseAutoFocus = (event: Event) => {
    const o = opener.current;
    opener.current = null;
    event.preventDefault(); // always: Radix would otherwise focus <body> when the opener is gone
    if (!o) return;
    const own = document.querySelector<HTMLElement>(`[data-deal-main="${CSS.escape(o.id)}"], [data-deal-row="${CSS.escape(o.id)}"]`);
    returnFocus(o.from, own);
  };
  return (
    <Dialog open={!!dealId} onOpenChange={(open) => (open ? null : onClose())}>
      {dealId ? (
        <DialogContent
          aria-describedby={undefined}
          onCloseAutoFocus={onCloseAutoFocus}
          className={cn(
            "deal-sheet top-auto bottom-0 flex max-h-[calc(100dvh-12px)] w-full flex-col overflow-hidden rounded-b-none rounded-t-[24px] pb-[env(safe-area-inset-bottom)]",
            "lg:inset-y-3 lg:right-3 lg:left-auto lg:mx-0 lg:max-h-none lg:w-[440px] lg:rounded-[24px]",
          )}
        >
          <SheetBody key={dealId} dealId={dealId} onClose={onClose} flows={flows} team={team} canAssign={canAssign} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function SheetBody({ dealId, onClose, flows, team, canAssign }: { dealId: string; onClose: () => void; flows: SheetFlows; team: TeamMember[]; canAssign: boolean }) {
  const t = useTranslations("Deals");
  const tStage = useTranslations("Stages");
  const tPipe = useTranslations("Pipeline");
  const tHint = useTranslations("Errors.hint");
  const tF = useTranslations("Fulfilment");
  const tReason = useTranslations("LostReasons");
  const format = useFormatter();
  const locale = useLocale();
  const router = useRouter();
  const toast = useToast();
  const [now] = useState(() => Date.now());
  const query = useQuery({ queryKey: dealKey(dealId), queryFn: () => fetchDealClient(dealId), staleTime: 10_000 });
  const deal = query.data;
  const leadQuery = useQuery({
    queryKey: leadKey(deal?.lead.id ?? "none"),
    queryFn: () => fetchLead(deal!.lead.id),
    enabled: !!deal && deal.can_edit,
    staleTime: 30_000,
  });

  const header = (title: React.ReactNode) => (
    <div className="flex items-start gap-2 border-b border-border px-5 pt-4 pb-3">
      <span aria-hidden="true" className="absolute top-1.5 left-1/2 h-1 w-9 -translate-x-1/2 rounded-full bg-border lg:hidden" />
      <div className="min-w-0 flex-1 pt-1">{title}</div>
      {deal ? <SheetMenu deal={deal} flows={flows} onDeleted={onClose} /> : null}
      <button
        type="button"
        onClick={onClose}
        aria-label={t("sheet.close")}
        className="-mr-2 grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground transition-[color,scale] duration-150 hover:text-foreground active:scale-[0.97]"
      >
        <X aria-hidden="true" strokeWidth={1.75} className="size-5" />
      </button>
    </div>
  );

  if (query.isPending) {
    return (
      <>
        {header(<DialogTitle className="sr-only">{t("sheet.label")}</DialogTitle>)}
        <div aria-busy="true" className="flex flex-col gap-4 p-5">
          <div className="h-7 w-3/4 rounded-sm bg-muted motion-safe:animate-pulse" />
          <div className="h-5 w-1/2 rounded-sm bg-muted motion-safe:animate-pulse" />
          <div className="h-11 rounded-md bg-muted motion-safe:animate-pulse" />
          <div className="h-24 rounded-md bg-muted motion-safe:animate-pulse" />
        </div>
      </>
    );
  }
  if (query.isError) {
    return (
      <>
        {header(<DialogTitle className="text-lg font-bold">{t("sheet.loadFailed")}</DialogTitle>)}
        <div role="alert" className="flex flex-col items-start gap-3 p-5">
          <Button variant="quiet" onClick={() => void query.refetch()}>
            {tPipe("retry")}
          </Button>
        </div>
      </>
    );
  }
  if (!deal) {
    return (
      <>
        {header(<DialogTitle className="text-lg font-bold">{t("sheet.notAvailable")}</DialogTitle>)}
        <p className="p-5 text-sm text-muted-foreground">{t("sheet.notAvailableBody")}</p>
      </>
    );
  }

  const open = deal.status === "open";
  const editable = deal.can_edit && open;
  const ownerName = personName(deal.owner) || null;
  const undo = deal.undo && Date.parse(deal.undo.until) > now ? deal.undo : null;
  const days = elapsedDays(deal.stage_entered_at, now);
  const path = dealPath(deal.history, now);

  const pick = (stage: StageKey) => {
    if (!deal.can_edit) return;
    if (stage === "won") return flows.openWin(deal);
    if (stage === "lost") return flows.openLose(deal);
    if (!open) return flows.openReopen(deal, stage);
    void flows.actions.move(deal, stage);
  };

  return (
    <>
      {header(
        <>
          <DialogTitle className="text-xl leading-7 font-bold break-words">
            <Link
              href={`/leads/${deal.lead.id}`}
              onPointerEnter={() => router.prefetch(`/leads/${deal.lead.id}`)}
              className="underline-offset-4 hover:underline"
            >
              {deal.lead.name}
            </Link>
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">{[deal.lead.city, deal.lead.country].filter(Boolean).join(" · ") || t("sheet.label")}</DialogDescription>
        </>,
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain p-5">
        {!deal.can_edit ? (
          <p className="text-sm text-muted-foreground">{ownerName ? t("readOnly", { owner: ownerName }) : t("readOnlyUnowned")}</p>
        ) : null}
        {deal.lead.lead_status === "do_not_contact" ? (
          <p className="inline-flex items-center gap-2 text-sm">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-status-red" />
            {t("dnc")}
          </p>
        ) : null}

        <InlineText
          label={t("fields.title")}
          placeholder={t("fields.titlePlaceholder")}
          value={deal.title}
          disabled={!deal.can_edit}
          onSave={(v) => saveField(deal, flows, toast, t, ["title"], { title: v }, (d) => d.title === deal.title)}
          validate={(v) => Array.from(v).length <= DEAL_TITLE_MAX && !UNSAFE_TITLE.test(v)}
          titleInvalidText={tHint("deal_title")}
        />
        <InlineMoney deal={deal} disabled={!editable} flows={flows} />

        <section aria-label={t("sheet.stage")} className="flex flex-col gap-2">
          <h3 className="text-sm font-bold text-muted-foreground">{t("sheet.stage")}</h3>
          <StageStepper card={deal} disabled={!deal.can_edit} onPick={pick} onLose={() => flows.openLose(deal)} />
          <p className="text-sm text-muted-foreground">
            {open
              ? `${t("daysInStage", { count: days })}${deal.is_stalled && deal.stall_days ? ` · ${t("stalledHint", { quiet: deal.quiet_days ?? days, limit: deal.stall_days, stage: tStage(deal.stage) })}` : ""}`
              : deal.closed_at
                ? t("sheet.closedOn", { date: format.dateTime(new Date(deal.closed_at), { day: "numeric", month: "short", year: "numeric" }) })
                : null}
          </p>
          {!open && deal.can_edit ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm text-muted-foreground">{t("sheet.reopenToEdit")}</p>
              <Button variant="quiet" className="min-h-11 sm:min-h-9" onClick={() => flows.openReopen(deal, reopenStage(deal.history))}>
                {t("menu.reopen")}
              </Button>
            </div>
          ) : null}
          {undo && deal.can_edit ? (
            <Button
              variant="quiet"
              className="min-h-11 self-start sm:min-h-9"
              onClick={() => {
                const last = lastUndoableMove();
                void flows.actions.undo(
                  last && last.historyId === undo.history_id
                    ? last
                    : { id: deal.id, historyId: undo.history_id, fromStage: undo.to_stage, toStage: deal.stage, version: deal.version, at: Date.now(), until: Date.parse(undo.until), leadId: deal.lead.id, lostReason: deal.lost_reason },
                );
              }}
            >
              <Undo2 aria-hidden="true" strokeWidth={1.75} className="size-4" />
              {t("menu.undo")}
            </Button>
          ) : null}
        </section>

        <CloseDate deal={deal} disabled={!editable} flows={flows} />

        <Field label={t("fields.contact")}>
          <Select
            name="contact"
            aria-label={t("fields.contact")}
            className="text-sm"
            value={deal.contact_id ?? ""}
            disabled={!deal.can_edit || !leadQuery.data}
            onChange={(e) => void saveField(deal, flows, toast, t, ["contact_id"], { contactId: e.target.value || null }, (d) => d.contact_id === deal.contact_id)}
          >
            <option value="">{deal.contact ? personName(deal.contact) : t("fields.noContact")}</option>
            {(leadQuery.data?.contacts ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {personName(c)}
              </option>
            ))}
          </Select>
        </Field>

        <Field label={t("fields.fulfilment")}>
          <div role="radiogroup" aria-label={t("fields.fulfilment")} className="grid grid-cols-3 gap-1 rounded-md bg-muted p-1">
            {([null, ...fulfilments] as (Fulfilment | null)[]).map((f) => {
              const on = deal.fulfilment === f;
              return (
                <button
                  key={f ?? "none"}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={!editable}
                  onClick={() => !on && void saveField(deal, flows, toast, t, ["fulfilment"], { fulfilment: f }, (d) => d.fulfilment === deal.fulfilment)}
                  className={cn(
                    "min-h-11 rounded-sm px-1 text-xs leading-4 font-bold transition-[background-color,color,scale] duration-150 active:scale-[0.97] disabled:opacity-60 sm:text-[13px]",
                    on ? "bg-pill text-foreground shadow-[0_1px_2px_rgb(14_14_16/0.12)]" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {f === null ? tF("undecided") : tF(`${f}.title`)}
                </button>
              );
            })}
          </div>
        </Field>

        {canAssign ? (
          <Field label={t("fields.owner")}>
            <Select
              name="owner"
              aria-label={t("fields.owner")}
              className="text-sm"
              value={deal.owner_id ?? ""}
              disabled={!deal.can_edit}
              onChange={(e) => e.target.value && void saveField(deal, flows, toast, t, ["owner_id"], { ownerId: e.target.value }, (d) => d.owner_id === deal.owner_id)}
            >
              {team.map((m) => (
                <option key={m.id} value={m.id}>
                  {personName(m)}
                </option>
              ))}
            </Select>
          </Field>
        ) : ownerName ? (
          <Field label={t("fields.owner")}>
            <p className="text-sm">{ownerName}</p>
          </Field>
        ) : null}

        <section aria-label={t("sheet.path")} className="flex flex-col gap-2">
          <h3 className="text-sm font-bold text-muted-foreground">{t("sheet.path")}</h3>
          <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
            {path.map((p, i) => (
              <li key={i} className="flex items-center gap-1.5">
                {i > 0 ? <span aria-hidden="true" className="text-muted-foreground">→</span> : null}
                <span className={cn(p.current && "font-bold")}>
                  {p.current ? t("pathCurrent", { stage: tStage(p.stage), days: p.days }) : t("pathStep", { stage: tStage(p.stage), days: p.days })}
                </span>
              </li>
            ))}
          </ol>
        </section>

        <section aria-label={t("sheet.history")} className="flex flex-col gap-2">
          <h3 className="text-sm font-bold text-muted-foreground">{t("sheet.history")}</h3>
          <ul className="flex flex-col gap-1.5 text-sm">
            {deal.history.map((h) => {
              const name = h.actor_first_name || t("history.someone");
              const text =
                h.kind === "open"
                  ? t("history.open", { name, stage: tStage(h.to_stage) })
                  : h.kind === "won"
                    ? h.value
                      ? t("history.wonValue", { name, value: formatMoney(h.value, locale) })
                      : t("history.won", { name })
                    : h.kind === "lost"
                      ? t("history.lost", { name, reason: h.lost_reason ? tReason(h.lost_reason) : "" })
                      : h.kind === "reopen"
                        ? t("history.reopen", { name, stage: tStage(h.to_stage) })
                        : h.kind === "undo"
                          ? t("history.undo", { name })
                          : t("history.move", { name, stage: tStage(h.to_stage) });
              return (
                <li key={h.id} className={cn("flex items-baseline justify-between gap-3", h.undone && "text-muted-foreground line-through decoration-1")}>
                  <span className="min-w-0 break-words">
                    {text}
                    {h.undone ? <span className="sr-only"> ({t("history.undoneTag")})</span> : null}
                  </span>
                  <time dateTime={h.created_at} className="shrink-0 font-mono text-xs text-muted-foreground">
                    {format.dateTime(new Date(h.created_at), { day: "numeric", month: "short" })}<span className="sr-only"> ({format.dateTime(new Date(h.created_at), { dateStyle: "medium", timeStyle: "short" })})</span>
                  </time>
                </li>
              );
            })}
          </ul>
        </section>

        <section aria-label={t("sheet.recent")} className="flex flex-col gap-2">
          <h3 className="text-sm font-bold text-muted-foreground">{t("sheet.recent")}</h3>
          {deal.activities.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("sheet.noRecent")}</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-sm">
              {deal.activities.map((a) => (
                <ActivityRow key={a.id} a={a} />
              ))}
            </ul>
          )}
          <Link href={`/leads/${deal.lead.id}`} className="min-h-11 self-start py-2 text-sm font-bold underline-offset-4 hover:underline sm:min-h-0">
            {t("sheet.logNote")}
          </Link>
        </section>
      </div>
    </>
  );
}

function ActivityRow({ a }: { a: DealDetail["activities"][number] }) {
  const tOut = useTranslations("Outcomes");
  const tTypes = useTranslations("Composer.types");
  const format = useFormatter();
  const what = a.outcome ? `${tTypes(a.type as "call")} · ${tOut(a.outcome as "interested")}` : tTypes(a.type as "note");
  return (
    <li className="flex items-baseline justify-between gap-3">
      <span className="min-w-0 break-words">
        {a.user_first_name ? `${a.user_first_name} · ` : ""}
        {what}
      </span>
      <time dateTime={a.created_at} className="shrink-0 font-mono text-xs text-muted-foreground">
        {format.dateTime(new Date(a.created_at), { day: "numeric", month: "short" })}
      </time>
    </li>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-bold text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

type T = ReturnType<typeof useTranslations<"Deals">>;

/**
 * Saves one field (update_deal with only that field). On a conflict: when the field did not change remotely, it is sent
 * again with the new version, silently; otherwise the person is asked (Keep yours / Use theirs) through the toast.
 */
async function saveField(
  deal: DealCard,
  flows: SheetFlows,
  toast: ReturnType<typeof useToast>,
  t: T,
  fields: UpdateField[],
  values: Parameters<SheetFlows["actions"]["update"]>[2],
  unchangedRemotely: (server: DealCard) => boolean,
): Promise<boolean> {
  const r = await flows.actions.update(deal, fields, values);
  if (!r) return false;
  if (r.result === "updated") {
    toast.show(t("toast.updated"));
    return true;
  }
  if (r.deal && unchangedRemotely(r.deal)) {
    const again = await flows.actions.update(r.deal, fields, values);
    return !!again && again.result === "updated";
  }
  const who = r.changed_by_first_name;
  toast.show(who ? t("theyChanged", { name: who }) : t("theyChangedSomeone"), {
    label: t("keepYours"),
    run: () => r.deal && void flows.actions.update(r.deal, fields, values),
  });
  return false;
}

function InlineText({
  label,
  placeholder,
  value,
  disabled,
  onSave,
  validate,
  titleInvalidText,
}: {
  label: string;
  placeholder: string;
  value: string | null;
  disabled: boolean;
  onSave: (v: string | null) => Promise<boolean>;
  validate: (v: string) => boolean;
  titleInvalidText: string;
}) {
  const id = useId();
  const [text, setText] = useState(value ?? "");
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setText(value ?? "");
  }
  const bad = !validate(text.trim());
  const commit = async () => {
    const v = text.trim() || null;
    if (v === (value ?? null) || bad) return;
    await onSave(v);
  };
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-bold text-muted-foreground">
        {label}
      </label>
      <Input
        id={id}
        name={id}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        dir="auto"
        aria-invalid={bad || undefined}
        aria-describedby={`${id}-err`}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape" && text !== (value ?? "")) {
            e.stopPropagation();
            setText(value ?? "");
          }
        }}
        className="text-base font-bold"
      />
      <p id={`${id}-err`} className="min-h-5 text-sm text-status-red">
        {bad ? titleInvalidText : null}
      </p>
    </div>
  );
}

function InlineMoney({ deal, disabled, flows }: { deal: DealDetail; disabled: boolean; flows: SheetFlows }) {
  const t = useTranslations("Deals");
  const toast = useToast();
  const locale = useLocale();
  const id = useId();
  const ref = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(() => moneyInputText(deal.value, locale));
  const [seen, setSeen] = useState(deal.value);
  if (seen !== deal.value) {
    setSeen(deal.value);
    setText(moneyInputText(deal.value, locale));
  }
  const parsed = text.trim() === "" ? null : parseMoney(text, locale);
  const bad = text.trim() !== "" && parsed === null;
  const commit = async () => {
    if (bad || parsed === deal.value || (parsed !== null && deal.value !== null && parsed === deal.value)) return;
    if (parsed !== null && deal.value !== null && Number(parsed) === Number(deal.value)) return;
    await saveField(deal, flows, toast, t, ["value"], { value: parsed }, (d) => d.value === deal.value);
  };
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-bold text-muted-foreground">
        {t("fields.value")}
      </label>
      {disabled && deal.value !== null ? (
        <p className="font-mono text-2xl tabular-nums">{formatMoney(deal.value, locale, { cents: true })}</p>
      ) : (
        <Input
          ref={ref}
          id={id}
          name="deal_value"
          data-deal-value
          inputMode="decimal"
          autoComplete="off"
          value={text}
          disabled={disabled}
          placeholder={t("addValue")}
          aria-invalid={bad || undefined}
          aria-describedby={`${id}-err`}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
          }}
          className="font-mono text-xl tabular-nums"
        />
      )}
      <p id={`${id}-err`} className="min-h-5 text-sm text-status-red">
        {bad ? t("edit.valueInvalid") : null}
      </p>
    </div>
  );
}

function CloseDate({ deal, disabled, flows }: { deal: DealDetail; disabled: boolean; flows: SheetFlows }) {
  const t = useTranslations("Deals");
  const toast = useToast();
  const format = useFormatter();
  const [picking, setPicking] = useState(false);
  const today = new Date();
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const endMonth = iso(new Date(today.getFullYear(), today.getMonth() + 1, 0));
  const endNext = iso(new Date(today.getFullYear(), today.getMonth() + 2, 0));
  const set = (v: string | null) => void saveField(deal, flows, toast, t, ["expected_close"], { expectedClose: v }, (d) => d.expected_close === deal.expected_close);
  const chip = (on: boolean) =>
    cn(
      "min-h-11 rounded-md px-3 text-sm transition-[background-color,color,scale] duration-150 active:scale-[0.97] disabled:opacity-60 sm:min-h-9",
      on ? "bg-primary text-primary-foreground" : "bg-muted text-foreground hover:brightness-95 dark:hover:brightness-125",
    );
  return (
    <Field label={t("fields.expectedClose")}>
      {deal.expected_close ? (
        <p className="font-mono text-sm">{format.dateTime(new Date(`${deal.expected_close}T12:00:00Z`), { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}</p>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        <button type="button" disabled={disabled} aria-pressed={deal.expected_close === endMonth} onClick={() => set(endMonth)} className={chip(deal.expected_close === endMonth)}>
          {t("closeChips.endMonth")}
        </button>
        <button type="button" disabled={disabled} aria-pressed={deal.expected_close === endNext} onClick={() => set(endNext)} className={chip(deal.expected_close === endNext)}>
          {t("closeChips.endNextMonth")}
        </button>
        <button type="button" disabled={disabled} aria-pressed={picking} onClick={() => setPicking((p) => !p)} className={chip(picking)}>
          {t("closeChips.pick")}
        </button>
        {deal.expected_close ? (
          <button type="button" disabled={disabled} onClick={() => set(null)} className={chip(false)}>
            {t("closeChips.clear")}
          </button>
        ) : null}
      </div>
      {picking ? (
        <DatePicker
          name="expected_close"
          aria-label={t("closeChips.pick")}
          defaultValue={deal.expected_close ?? ""}
          disabled={disabled}
          clearable={false}
          onValueChange={(v) => v && set(v)}
        />
      ) : null}
    </Field>
  );
}

function SheetMenu({ deal, flows, onDeleted }: { deal: DealDetail; flows: SheetFlows; onDeleted: () => void }) {
  const t = useTranslations("Deals");
  const toast = useToast();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("sheet.more")}
        className="grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground transition-[color,scale] duration-150 hover:text-foreground active:scale-[0.97]"
      >
        <MoreHorizontal aria-hidden="true" strokeWidth={1.75} className="size-5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem
          onSelect={() => {
            void navigator.clipboard?.writeText(`${window.location.origin}/pipeline?deal=${deal.id}`).then(() => toast.show(t("menu.linkCopied")));
          }}
        >
          <Copy aria-hidden="true" strokeWidth={1.75} className="size-4 text-muted-foreground" />
          {t("menu.copyLink")}
        </DropdownMenuItem>
        {deal.can_delete ? (
          <DropdownMenuItem className="text-status-red" onSelect={() => flows.openDelete(deal, (ok) => ok && onDeleted())}>
            <Trash2 aria-hidden="true" strokeWidth={1.75} className="size-4" />
            {t("menu.delete")}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
