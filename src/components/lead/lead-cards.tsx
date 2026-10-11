"use client";

import { memo, useState, useSyncExternalStore } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Mail, MessageCircle, Pencil, Phone, Plus } from "lucide-react";
import { addContact, updateContact } from "@/app/(app)/leads/actions";
import { createTask, setTaskDone } from "@/app/(app)/leads/[id]/actions";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useCallPanel } from "@/components/activity/call-panel";
import { leadTasksKey, refreshLead, useLeadTasks } from "@/components/activity/use-activities";
import { ContactForm, contactToValues } from "@/components/leads/contact-form";
import { callTarget } from "@/components/lead/lead-data";
import { useClientNow } from "@/components/lead/local-time";
import { mailHref, personName, type LeadDetail } from "@/lib/leads";
import { callHref, whatsappHref } from "@/lib/phone";
import { DATE_CHIPS, LEAD_TASKS_SHOWN, chipDate, isOverdue, type LeadTask } from "@/lib/tasks";
import { addDays, browserZone, localDate, primaryZone } from "@/lib/timezones";
import { cn } from "@/lib/utils";

const noop = () => () => {};
function useViewerZone() {
  return useSyncExternalStore(noop, () => browserZone() ?? "Europe/Paris", () => "Europe/Paris");
}

export function Card({ title, action, children, className }: { title: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={cn("flex min-w-0 flex-col gap-3 rounded-lg bg-card p-4 sm:p-5", className)}>
      <div className="flex min-h-9 items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-muted-foreground">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** "Today", "Tomorrow 10:00", "Tue 14 Oct": a task's due label in the viewer's zone. */
function useDueLabel() {
  const t = useTranslations("LeadPage.tasks");
  const format = useFormatter();
  const zone = useViewerZone();
  return (task: Pick<LeadTask, "due_date" | "due_at">, now: Date | null) => {
    if (!task.due_date && !task.due_at) return t("noDate");
    const date = task.due_at ? localDate(zone, new Date(task.due_at)) : (task.due_date as string);
    const time = task.due_at ? format.dateTime(new Date(task.due_at), { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: zone }) : null;
    const today = now ? localDate(zone, now) : null;
    const day =
      today && date === today
        ? t("today")
        : today && date === addDays(today, 1)
          ? t("tomorrow")
          : format.dateTime(new Date(`${date}T12:00:00Z`), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
    return time ? `${day} ${time}` : day;
  };
}

/** A task with its round check: done at once (optimistic), with Undo. */
function TaskRow({ task, leadId, now }: { task: LeadTask; leadId: string; now: Date | null }) {
  const t = useTranslations("LeadPage.tasks");
  const tErr = useTranslations("Errors");
  const queryClient = useQueryClient();
  const toast = useToast();
  const zone = useViewerZone();
  const dueLabel = useDueLabel();
  const overdue = now ? isOverdue(task, zone, now) : false;

  const toggle = async () => {
    const before = queryClient.getQueryData<LeadTask[]>(leadTasksKey(leadId));
    queryClient.setQueryData<LeadTask[]>(leadTasksKey(leadId), (old) => old?.filter((x) => x.id !== task.id));
    const res = await setTaskDone({ id: task.id, on: true }).catch(() => ({ ok: false as const, error: "unavailable" as const }));
    if (!res.ok) {
      queryClient.setQueryData(leadTasksKey(leadId), before);
      toast.show(tErr(res.error));
      return;
    }
    refreshLead(queryClient, leadId);
    toast.show(t("done", { title: task.title }), {
      label: t("undo"),
      run: async () => {
        await setTaskDone({ id: task.id, on: false }).catch(() => null);
        refreshLead(queryClient, leadId);
      },
    });
  };

  return (
    <li className="flex items-start gap-2">
      <button
        type="button"
        role="checkbox"
        aria-checked={false}
        aria-label={t("markDone", { title: task.title })}
        onClick={() => void toggle()}
        className="group grid size-11 shrink-0 place-items-center rounded-full transition-transform duration-150 active:scale-[0.94] sm:size-9"
      >
        <span className="grid size-5 place-items-center rounded-full border-2 border-muted-foreground transition-colors group-hover:border-foreground">
          <Check aria-hidden="true" strokeWidth={3} className="size-3 opacity-0 transition-opacity group-hover:opacity-60" />
        </span>
      </button>
      <div className="flex min-w-0 flex-1 flex-col pt-2.5 sm:pt-1.5">
        <span className="text-sm break-words">{task.title}</span>
        <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          <span className="font-mono">{dueLabel(task, now)}</span>
          {overdue ? <span className="font-bold text-status-red">{t("overdue")}</span> : null}
          {task.assignee_first_name || task.assignee_last_name ? (
            <span>{personName({ first_name: task.assignee_first_name, last_name: task.assignee_last_name })}</span>
          ) : null}
        </span>
      </div>
    </li>
  );
}

/**
 * The next step (Summary): the lead's open tasks with their round checks, the next one first; the next call attempt on
 * the lead's side ("Thu 10:00 their time · Change"); or "No next step" with date chips that add a call task.
 */
// Memoised: the lead page draws again on every tab switch (design 8.6: 100 ms).
export const NextStepCard = memo(function NextStepCard({ lead, initialTasks, onChangeNext }: { lead: LeadDetail; initialTasks: LeadTask[] | null; onChangeNext: () => void }) {
  const t = useTranslations("LeadPage");
  const tTitle = useTranslations("Outcomes.taskTitle");
  const tComposer = useTranslations("Composer");
  const tErr = useTranslations("Errors");
  const format = useFormatter();
  const queryClient = useQueryClient();
  const toast = useToast();
  const zone = useViewerZone();
  const now = useClientNow(60_000);
  const tasks = useLeadTasks(lead.id, initialTasks);
  const [adding, setAdding] = useState(false);
  const first = tasks.data?.[0] ?? null;
  const theirZone = primaryZone(lead.call_zone_key ?? "Europe/Paris");

  const add = async (date: string) => {
    setAdding(true);
    const res = await createTask({
      title: tTitle("followUp", { lead: lead.name }),
      leadId: lead.id,
      contactId: null,
      kind: "call",
      dueDate: date,
      dueAt: null,
      assigneeId: null,
      requestId: crypto.randomUUID(),
    }).catch(() => ({ ok: false as const, error: "unavailable" as const }));
    setAdding(false);
    if (!res.ok) {
      toast.show(tErr(res.error));
      return;
    }
    refreshLead(queryClient, lead.id);
    toast.show(t("taskAdded"));
  };

  const nextAttempt =
    lead.next_action_at && lead.lead_status !== "do_not_contact" ? (
      <p className="flex flex-wrap items-center gap-x-2 text-sm">
        <span>
          {t("nextAttempt", {
            when: format.dateTime(new Date(lead.next_action_at), {
              weekday: "short",
              day: "numeric",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
              hourCycle: "h23",
              timeZone: theirZone,
            }),
          })}
        </span>
        {lead.can_edit ? (
          <button type="button" onClick={onChangeNext} className="min-h-11 font-bold underline-offset-4 hover:underline sm:min-h-0">
            {t("change")}
          </button>
        ) : null}
      </p>
    ) : null;

  let content: React.ReactNode;
  if (tasks.isPending) {
    content = <div aria-hidden="true" className="h-11 rounded-md bg-muted motion-safe:animate-pulse" />;
  } else if (tasks.isError) {
    content = (
      <div role="alert" className="flex flex-col items-start gap-2">
        <p className="text-sm">{t("tasks.error")}</p>
        <Button variant="quiet" onClick={() => void tasks.refetch()}>
          {t("tasks.retry")}
        </Button>
      </div>
    );
  } else if (first) {
    // Every open task the viewer can see, the next one first; then when the lead comes back to the queue.
    content = (
      <div className="flex flex-col gap-3">
        <ul className="flex flex-col gap-1">
          {tasks.data.slice(0, LEAD_TASKS_SHOWN).map((task) => (
            <TaskRow key={task.id} task={task} leadId={lead.id} now={now} />
          ))}
        </ul>
        {tasks.data.length > LEAD_TASKS_SHOWN ? (
          <p className="text-sm text-muted-foreground">{t("tasks.more", { count: LEAD_TASKS_SHOWN })}</p>
        ) : null}
        {nextAttempt}
      </div>
    );
  } else if (nextAttempt) {
    content = nextAttempt;
  } else {
    content = (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">{lead.lead_status === "do_not_contact" ? t("noNextStepDnc") : t("noNextStep")}</p>
        {/* No call is planned for a lead that asked not to be contacted. */}
        {now && lead.lead_status !== "do_not_contact" ? (
          <div className="flex flex-wrap gap-1.5">
            {DATE_CHIPS.map((c) => (
              <button
                key={c}
                type="button"
                disabled={adding}
                onClick={() => void add(chipDate(c, zone, now))}
                className="min-h-11 rounded-md bg-muted px-3 text-sm transition-[filter,transform] duration-150 hover:brightness-95 active:scale-[0.97] disabled:opacity-60 sm:min-h-9 dark:hover:brightness-125"
              >
                {tComposer(`chips.${c}`)}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  return <Card title={t("nextStep")}>{content}</Card>;
});

/** Contacts with Call, Email and WhatsApp each; a wrong number is struck through ("Marked wrong · Fix"). */
// Memoised: the lead page draws again on every tab switch (design 8.6: 100 ms).
export const ContactsCard = memo(function ContactsCard({ lead, readOnlyContact }: { lead: LeadDetail; readOnlyContact: boolean }) {
  const t = useTranslations("Leads.preview");
  const tLead = useTranslations("LeadPage");
  const tContact = useTranslations("Leads.contactForm");
  const tQuick = useTranslations("QuickActions");
  const queryClient = useQueryClient();
  const toast = useToast();
  const { startCall } = useCallPanel();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const dnc = lead.lead_status === "do_not_contact";
  const refresh = () => refreshLead(queryClient, lead.id);

  return (
    <Card
      title={`${t("contactsTitle")} · ${lead.contacts.length}`}
      action={
        lead.can_edit && !readOnlyContact && editing !== "new" ? (
          <Button variant="link" onClick={() => setEditing("new")} className="min-h-11 gap-1 text-sm sm:min-h-9">
            <Plus aria-hidden="true" strokeWidth={1.75} className="size-4" />
            {t("addContact")}
          </Button>
        ) : null
      }
    >
      {editing === "new" ? (
        <ContactForm
          initial={contactToValues()}
          onCancel={() => setEditing(null)}
          onSubmit={async (values) => {
            const res = await addContact(lead.id, values);
            if (!res.ok) return res.error;
            setEditing(null);
            refresh();
            toast.show(tContact("added"));
            return null;
          }}
        />
      ) : null}
      {lead.contacts.length === 0 && editing !== "new" ? (
        <p className="text-sm text-muted-foreground">{t("noContacts")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {lead.contacts.map((c) => {
            const name = personName(c) || t("notSet");
            if (editing === c.id) {
              return (
                <li key={c.id} className="py-2">
                  <ContactForm
                    initial={contactToValues(c)}
                    onCancel={() => setEditing(null)}
                    onSubmit={async (values) => {
                      const res = await updateContact(c.id, values);
                      if (!res.ok) return res.error;
                      setEditing(null);
                      refresh();
                      toast.show(tContact("saved"));
                      return null;
                    }}
                  />
                </li>
              );
            }
            const wrong = !!c.phone_wrong_at;
            const wa = c.phone && !wrong ? whatsappHref(c.phone, lead.country) : null;
            return (
              <li key={c.id} className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
                <div className="flex items-start gap-2">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="text-sm font-bold break-words">{name}</span>
                    {c.title ? <span className="text-xs text-muted-foreground">{c.title}</span> : null}
                  </div>
                  {lead.can_edit && !readOnlyContact ? (
                    <button
                      type="button"
                      onClick={() => setEditing(c.id)}
                      aria-label={t("editContact", { name })}
                      className="grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground transition-[color,transform] duration-150 hover:text-foreground active:scale-[0.97] sm:size-9"
                    >
                      <Pencil aria-hidden="true" strokeWidth={1.75} className="size-4" />
                    </button>
                  ) : null}
                </div>
                {c.phone ? (
                  <p className="flex flex-wrap items-center gap-x-2 text-sm">
                    <span className={cn("font-mono", wrong && "text-muted-foreground line-through")} translate="no">
                      {c.phone}
                    </span>
                    {wrong ? (
                      <span className="text-xs text-muted-foreground">
                        {tLead("markedWrong")}
                        {lead.can_edit && !readOnlyContact ? (
                          <>
                            {" · "}
                            <button type="button" onClick={() => setEditing(c.id)} className="min-h-11 font-bold text-foreground underline-offset-4 hover:underline sm:min-h-0">
                              {tLead("fix")}
                            </button>
                          </>
                        ) : null}
                      </span>
                    ) : null}
                  </p>
                ) : null}
                {c.email ? <p className="text-sm break-all text-muted-foreground">{c.email}</p> : null}
                {!dnc && ((c.phone && !wrong) || c.email) ? (
                  <div className="flex flex-wrap gap-1.5">
                    {c.phone && !wrong ? (
                      <a
                        href={callHref(c.phone, lead.country)}
                        onClick={(e) =>
                          startCall(
                            callTarget(lead, { number: c.phone as string, dialled: "contact", contactId: c.id, contactName: personName(c) || null, wrong }),
                            e.currentTarget,
                          )
                        }
                        aria-label={tLead("callContact", { name })}
                        className="inline-flex min-h-11 items-center gap-1.5 rounded-md bg-muted px-3 text-sm transition-[filter,transform] duration-150 hover:brightness-95 active:scale-[0.97] sm:min-h-9 dark:hover:brightness-125"
                      >
                        <Phone aria-hidden="true" strokeWidth={1.75} className="size-4" />
                        {tQuick("call")}
                      </a>
                    ) : null}
                    {c.email ? (
                      <a
                        href={mailHref(c.email)}
                        aria-label={tLead("emailContact", { name })}
                        className="inline-flex min-h-11 items-center gap-1.5 rounded-md bg-muted px-3 text-sm transition-[filter,transform] duration-150 hover:brightness-95 active:scale-[0.97] sm:min-h-9 dark:hover:brightness-125"
                      >
                        <Mail aria-hidden="true" strokeWidth={1.75} className="size-4" />
                        {tQuick("email")}
                      </a>
                    ) : null}
                    {wa ? (
                      <a
                        href={wa}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={tLead("whatsappContact", { name })}
                        className="inline-flex min-h-11 items-center gap-1.5 rounded-md bg-muted px-3 text-sm transition-[filter,transform] duration-150 hover:brightness-95 active:scale-[0.97] sm:min-h-9 dark:hover:brightness-125"
                      >
                        <MessageCircle aria-hidden="true" strokeWidth={1.75} className="size-4" />
                        {tQuick("whatsapp")}
                      </a>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
});
