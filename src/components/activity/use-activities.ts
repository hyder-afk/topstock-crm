"use client";

import { useCallback } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { logActivity, undoActivity } from "@/app/(app)/leads/[id]/actions";
import { useToast } from "@/components/ui/toast";
import { leadKey, fetchLead } from "@/components/leads/use-leads";
import {
  UNDO_SECONDS,
  UNDO_TOAST_SECONDS,
  type LogActivityInput,
  type LoggedActivity,
  type TimelineEntry,
  type TimelineFilter,
  type TimelinePage,
} from "@/lib/activities";
import type { ActionResult } from "@/lib/db-errors";
import type { LeadDetail, LeadStatus } from "@/lib/leads";
import type { LeadTask } from "@/lib/tasks";

// Timeline, tasks and logging shared by the lead page, the composer and the call panel (Day 4 design 7.2 and 7.3).
// Query keys: ["timeline", leadId, filter] (pages of 30, keyset), ["lead-tasks", leadId], and Day 3a's ["lead", id].

export const timelineKey = (leadId: string, filter: TimelineFilter) => ["timeline", leadId, filter] as const;
export const leadTasksKey = (leadId: string) => ["lead-tasks", leadId] as const;
type Cursor = TimelinePage["next"];

export async function fetchTimeline(leadId: string, filter: TimelineFilter, cursor: Cursor): Promise<TimelinePage> {
  const params = new URLSearchParams();
  if (filter !== "all") params.set("types", filter);
  if (cursor) {
    params.set("before_at", cursor.before_at);
    params.set("before_id", cursor.before_id);
  }
  const qs = params.toString();
  const res = await fetch(`/api/leads/${leadId}/activities${qs ? `?${qs}` : ""}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as TimelinePage;
}

export function useTimeline(leadId: string, filter: TimelineFilter, initial?: TimelinePage | null) {
  return useInfiniteQuery({
    queryKey: timelineKey(leadId, filter),
    queryFn: ({ pageParam }) => fetchTimeline(leadId, filter, pageParam),
    initialPageParam: null as Cursor,
    getNextPageParam: (last) => last.next,
    initialData: initial && filter === "all" ? { pages: [initial], pageParams: [null] } : undefined,
  });
}

export async function fetchLeadTasks(leadId: string): Promise<LeadTask[]> {
  const res = await fetch(`/api/leads/${leadId}/tasks`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as LeadTask[];
}

export function useLeadTasks(leadId: string, initial?: LeadTask[] | null) {
  return useQuery({ queryKey: leadTasksKey(leadId), queryFn: () => fetchLeadTasks(leadId), initialData: initial ?? undefined });
}

/** Warms the lead page before it opens (hover intent on a row, focus on Open lead): the lead and its first timeline page. */
export function prefetchLead(queryClient: QueryClient, id: string) {
  void queryClient.prefetchQuery({ queryKey: leadKey(id), queryFn: () => fetchLead(id), staleTime: 30_000 });
  void queryClient.prefetchInfiniteQuery({
    queryKey: timelineKey(id, "all"),
    queryFn: ({ pageParam }) => fetchTimeline(id, "all", pageParam as Cursor),
    initialPageParam: null as Cursor,
    staleTime: 30_000,
  });
}

/** Everything that shows this lead's entries, tasks or state is fetched again. */
export function refreshLead(queryClient: QueryClient, leadId: string) {
  void queryClient.invalidateQueries({ queryKey: ["timeline", leadId] });
  void queryClient.invalidateQueries({ queryKey: leadTasksKey(leadId) });
  void queryClient.invalidateQueries({ queryKey: leadKey(leadId) });
  void queryClient.invalidateQueries({ queryKey: ["leads"] });
}

// The last entry this tab logged, for U and Cmd/Ctrl+Z (design 5.3: toast 10 s, keys and the entry menu 2 minutes).
let lastLogged: { activityId: string; leadId: string; until: number } | null = null;
export function lastUndoable() {
  return lastLogged && lastLogged.until > Date.now() ? lastLogged : null;
}

type LogArgs = {
  input: Omit<LogActivityInput, "requestId">;
  /** Shown in the timeline at once (optimistic), replaced by the saved entry. */
  preview: Pick<TimelineEntry, "contact_name">;
  /** Names for the toast ("Logged: No answer · back Tue 13 Oct"). */
  ownerName: string | null;
};

/**
 * Logs an entry: it shows in the timeline at once with its request id, then the saved entry replaces it, or it goes
 * away again with a toast (the composer keeps the text). Answers the action's result. A replay of the same request id
 * (a retry after a lost answer) is stored once by the database.
 */
export function useLogActivity() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const t = useTranslations("Outcomes");
  const tTypes = useTranslations("Composer.types");
  const tStatus = useTranslations("Leads.status");
  const tErr = useTranslations("Errors");
  const format = useFormatter();
  const undo = useUndoActivity();

  return useCallback(
    async ({ input, preview, ownerName }: LogArgs): Promise<ActionResult<LoggedActivity>> => {
      const requestId = crypto.randomUUID();
      const key = timelineKey(input.leadId, "all");
      const now = new Date().toISOString();
      const optimistic: TimelineEntry = {
        id: `pending-${requestId}`,
        type: input.type,
        outcome: input.outcome,
        body: input.body.trim() ? input.body : null,
        truncated: false,
        contact_id: input.contactId,
        contact_name: preview.contact_name,
        user_id: null,
        user_first_name: null,
        user_last_name: null,
        created_at: now,
        edited_at: null,
        is_mine: true,
        undo_until: null,
        task_title: null,
        task_due_date: null,
        task_due_at: null,
        task_done_at: null,
        pending: true,
      };
      await queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData<InfiniteData<TimelinePage>>(key, (old) =>
        old ? { ...old, pages: old.pages.map((p, i) => (i === 0 ? { ...p, entries: [optimistic, ...p.entries] } : p)) } : old,
      );
      const drop = () =>
        queryClient.setQueryData<InfiniteData<TimelinePage>>(key, (old) =>
          old ? { ...old, pages: old.pages.map((p) => ({ ...p, entries: p.entries.filter((e) => e.id !== optimistic.id) })) } : old,
        );

      let result: ActionResult<LoggedActivity>;
      try {
        result = await logActivity({ ...input, requestId });
      } catch {
        result = { ok: false, error: "unavailable" };
      }
      if (!result.ok) {
        drop();
        toast.show(tErr(result.error === "invalid" && result.hint ? `hint.${result.hint}` : result.error));
        return result;
      }
      const saved = result.data;
      lastLogged = saved.undo_until ? { activityId: saved.activity_id, leadId: input.leadId, until: Date.parse(saved.undo_until) } : null;
      refreshLead(queryClient, input.leadId);

      // "Logged: No answer · back Tue 13 Oct", or for someone who may not change the lead, the reason it stayed.
      // A call says its outcome ("No answer"); a meeting its kind and outcome ("Meeting · Held"); the rest their kind.
      const what =
        input.type === "call" && input.outcome
          ? t(input.outcome)
          : input.type === "meeting" && input.outcome
            ? `${tTypes("meeting")} · ${t(input.outcome)}`
            : tTypes(input.type);
      const parts = [t("toast.logged", { what })];
      if (input.type === "call" && saved.editable === false) {
        parts.push(ownerName ? t("toast.notEditable", { owner: ownerName }) : t("toast.notEditableUnowned"));
      } else if (input.type === "call") {
        if (saved.status_after && saved.status_after !== saved.status_before) {
          parts.push(t("toast.status", { status: tStatus(saved.status_after as LeadStatus) }));
        }
        if (saved.next_action_at && saved.status_after !== "do_not_contact") {
          parts.push(t("toast.back", { date: format.dateTime(new Date(saved.next_action_at), { weekday: "short", day: "numeric", month: "short" }) }));
        }
      }
      toast.show(
        parts.join(" · "),
        saved.undo_until
          ? {
              label: t("toast.undo"),
              run: () => void undo(saved.activity_id, input.leadId, !!saved.status_after && saved.status_after !== saved.status_before),
            }
          : undefined,
        { duration: UNDO_TOAST_SECONDS * 1000 },
      );
      return result;
    },
    [queryClient, toast, t, tTypes, tStatus, tErr, format, undo],
  );
}

/** Takes back one's own entry within 2 minutes: the lead goes back as it was, unless a colleague changed it since. */
export function useUndoActivity() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const t = useTranslations("Outcomes.toast");
  const tErr = useTranslations("Errors");
  return useCallback(
    async (activityId: string, leadId: string, statusExpected = false) => {
      let result;
      try {
        result = await undoActivity({ id: activityId });
      } catch {
        result = { ok: false as const, error: "unavailable" as const };
      }
      if (!result.ok) {
        toast.show(tErr(result.error));
        return false;
      }
      if (lastLogged?.activityId === activityId) lastLogged = null;
      // The lead page shows the lead's restored state at once; the timeline drops the entry.
      queryClient.setQueryData<LeadDetail | null>(leadKey(leadId), (old) =>
        old && result.data.lead
          ? {
              ...old,
              lead_status: result.data.lead.lead_status as LeadStatus,
              next_action_at: result.data.lead.next_action_at,
              last_activity_at: result.data.lead.last_activity_at,
            }
          : old,
      );
      queryClient.setQueriesData<InfiniteData<TimelinePage>>({ queryKey: ["timeline", leadId] }, (old) =>
        old ? { ...old, pages: old.pages.map((p) => ({ ...p, entries: p.entries.filter((e) => e.id !== activityId) })) } : old,
      );
      refreshLead(queryClient, leadId);
      // The entry had changed the status, and it did not come back: a colleague changed it since (never overwritten).
      toast.show(statusExpected && !result.data.restored.status ? t("undonePartly") : t("undone"));
      return true;
    },
    [queryClient, toast, t, tErr],
  );
}

/** Seconds of Undo left for a timeline entry (0 when gone). */
export function undoLeft(entry: Pick<TimelineEntry, "undo_until" | "is_mine">, now: number) {
  if (!entry.is_mine || !entry.undo_until) return 0;
  return Math.max(0, Math.min(UNDO_SECONDS, Math.floor((Date.parse(entry.undo_until) - now) / 1000)));
}
