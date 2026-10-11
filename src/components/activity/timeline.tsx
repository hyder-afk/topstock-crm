"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { motion, useReducedMotion } from "motion/react";
import { CalendarDays, Mail, MessageCircle, MoreHorizontal, NotebookPen, Phone } from "lucide-react";
import { deleteActivity, editActivity } from "@/app/(app)/leads/[id]/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, phoneSheet } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { refreshLead, undoLeft, useTimeline, useUndoActivity } from "@/components/activity/use-activities";
import { useClientNow } from "@/components/lead/local-time";
import {
  BODY_MAX,
  TIMELINE_FILTERS,
  textLength,
  type ActivityType,
  type TimelineEntry,
  type TimelineFilter,
  type TimelinePage,
} from "@/lib/activities";
import { personName } from "@/lib/leads";
import { addDays, browserZone, localDate } from "@/lib/timezones";
import { cn } from "@/lib/utils";

// The lead's timeline (Day 4 design 7.2): newest first, 30 a page (keyset), grouped under Today / Yesterday / a date in
// the viewer's zone. An ordered list of articles; text is shown as text only (never HTML, never auto-linked), with
// dir="auto" so Arabic or Hebrew reads right, cut at 6 lines with Show more. Long histories rely on
// content-visibility (design D13). The author can edit the text, undo within 2 minutes and delete with a fresh code;
// managers and admins may delete others' entries.
export type StepUp = { ensureFresh: (minSeconds?: number) => Promise<boolean>; requireFresh: () => Promise<boolean> };

export const typeIcon: Record<ActivityType, typeof Phone> = {
  call: Phone,
  email: Mail,
  whatsapp: MessageCircle,
  meeting: CalendarDays,
  note: NotebookPen,
};

const noop = () => () => {};
function useViewerZone() {
  return useSyncExternalStore(noop, () => browserZone() ?? "Europe/Paris", () => "Europe/Paris");
}

export function Timeline({
  leadId,
  initial,
  initialFilter = "all",
  me,
  stepUp,
}: {
  leadId: string;
  initial: TimelinePage | null;
  initialFilter?: TimelineFilter;
  me: { id: string; role: string };
  stepUp: StepUp;
}) {
  const t = useTranslations("Timeline");
  const [filter, setFilterState] = useState<TimelineFilter>(initialFilter);
  // The filter is in the URL (?filter=calls…), like the tab: a reload or a shared link shows the same list.
  const setFilter = (next: TimelineFilter) => {
    setFilterState(next);
    const url = new URL(window.location.href);
    if (next === "all") url.searchParams.delete("filter");
    else url.searchParams.set("filter", next);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
  };
  const query = useTimeline(leadId, filter, initial);
  const entries = query.data?.pages.flatMap((p) => p.entries) ?? [];
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;

  // The next page loads when the end of the list comes into view; "Show older" does the same from the keyboard.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage) return;
    const observer = new IntersectionObserver(
      (items) => {
        if (items.some((i) => i.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <section aria-labelledby={`timeline-${leadId}`} className="flex flex-col gap-4">
      <h2 id={`timeline-${leadId}`} className="sr-only">
        {t("title")}
      </h2>
      <div role="group" aria-label={t("filterLabel")} className="flex flex-wrap gap-1.5">
        {TIMELINE_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={cn(
              "min-h-11 rounded-md px-3 text-sm transition-[background-color,color,transform] duration-150 active:scale-[0.97] sm:min-h-9",
              filter === f ? "bg-primary text-primary-foreground" : "bg-muted text-foreground hover:brightness-95 dark:hover:brightness-125",
            )}
          >
            {t(`filters.${f}`)}
          </button>
        ))}
      </div>

      {query.isPending ? (
        <TimelineSkeleton />
      ) : query.isError && entries.length === 0 ? (
        <div role="alert" className="flex flex-col items-start gap-3 rounded-lg bg-card p-6">
          <p className="font-bold">{t("error")}</p>
          <Button variant="quiet" onClick={() => void query.refetch()}>
            {t("retry")}
          </Button>
        </div>
      ) : entries.length === 0 ? (
        <p className="rounded-lg bg-card p-6 text-muted-foreground">{filter === "all" ? t("empty") : t("emptyFiltered")}</p>
      ) : (
        <>
          <EntryList key={filter} entries={entries} leadId={leadId} me={me} stepUp={stepUp} />
          <div ref={sentinel} className="flex flex-col items-start gap-2">
            {hasNextPage ? (
              isFetchingNextPage ? (
                <TimelineSkeleton rows={2} />
              ) : (
                <Button variant="quiet" onClick={() => void fetchNextPage()}>
                  {t("loadOlder")}
                </Button>
              )
            ) : (
              <p className="text-sm text-muted-foreground">{t("end")}</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** Entries grouped by day in the viewer's zone. Also used by Summary for the latest three. */
export function EntryList({
  entries,
  leadId,
  me,
  stepUp,
  grouped = true,
  compact = false,
}: {
  entries: TimelineEntry[];
  leadId: string;
  me: { id: string; role: string };
  stepUp: StepUp;
  grouped?: boolean;
  /** Inside a card (Summary): rows divided by lines instead of cards of their own. */
  compact?: boolean;
}) {
  const t = useTranslations("Timeline");
  const format = useFormatter();
  const zone = useViewerZone();
  const now = useClientNow(15_000);
  // Entries seen at the first draw do not animate; later ones (just logged) rise in once.
  const [seen] = useState(() => new Set(entries.map((e) => e.id)));

  const today = now ? localDate(zone, now) : null;
  const groups: { label: string; items: TimelineEntry[] }[] = [];
  for (const e of entries) {
    const day = localDate(zone, new Date(e.created_at));
    const label =
      today && day === today
        ? t("today")
        : today && day === addDays(today, -1)
          ? t("yesterday")
          : format.dateTime(new Date(e.created_at), { weekday: "short", day: "numeric", month: "short", timeZone: zone });
    const last = groups[groups.length - 1];
    if (grouped && last && last.label === label) last.items.push(e);
    else if (!grouped && last) last.items.push(e);
    else groups.push({ label, items: [e] });
  }

  return (
    <div className="flex flex-col gap-5">
      {groups.map((g) => (
        <div key={g.label + g.items[0].id} className="flex flex-col gap-2">
          {grouped ? <h3 className="font-mono text-xs text-muted-foreground">{g.label}</h3> : null}
          <ol className={cn("flex flex-col", compact ? "divide-y divide-border" : "gap-2")}>
            {g.items.map((e) => (
              <li key={e.id} style={{ contentVisibility: "auto", containIntrinsicSize: "auto 112px" }}>
                <EntryItem entry={e} leadId={leadId} me={me} stepUp={stepUp} now={now} fresh={!seen.has(e.id)} compact={compact} grouped={grouped} />
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

function EntryItem({
  entry,
  leadId,
  me,
  stepUp,
  now,
  fresh,
  compact,
  grouped,
}: {
  entry: TimelineEntry;
  leadId: string;
  me: { id: string; role: string };
  stepUp: StepUp;
  now: Date | null;
  fresh: boolean;
  compact: boolean;
  grouped: boolean;
}) {
  const t = useTranslations("Timeline");
  const tTypes = useTranslations("Composer.types");
  const tOut = useTranslations("Outcomes");
  const tErr = useTranslations("Errors");
  const format = useFormatter();
  const reduce = useReducedMotion();
  const queryClient = useQueryClient();
  const toast = useToast();
  const undo = useUndoActivity();
  const [expanded, setExpanded] = useState(false);
  const [full, setFull] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const bodyRef = useRef<HTMLParagraphElement>(null);
  const [clamped, setClamped] = useState(false);
  const Icon = typeIcon[entry.type];
  const Heading = grouped ? "h4" : "h3";
  const author = entry.is_mine ? t("you") : personName({ first_name: entry.user_first_name, last_name: entry.user_last_name }) || t("someone");
  const created = new Date(entry.created_at);
  const absolute = format.dateTime(created, { dateStyle: "full", timeStyle: "short" });
  const canDelete = !entry.pending && (entry.is_mine || me.role === "admin" || me.role === "manager");
  const undoSeconds = now ? undoLeft(entry, now.getTime()) : 0;
  const body = full ?? entry.body;

  // Whether the text is cut at 6 lines (then Show more appears).
  useEffect(() => {
    const el = bodyRef.current;
    if (el) setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [body, expanded]);

  const showMore = async () => {
    if (entry.truncated && full === null) {
      const res = await fetch(`/api/activities/${entry.id}`, { headers: { accept: "application/json" } });
      if (res.ok) setFull(((await res.json()) as { body: string | null }).body);
    }
    setExpanded(true);
  };

  const saveEdit = async () => {
    setSaving(true);
    const res = await editActivity({ id: entry.id, body: draft }).catch(() => ({ ok: false as const, error: "unavailable" as const }));
    setSaving(false);
    if (!res.ok) {
      toast.show(tErr("hint" in res && res.hint ? `hint.${res.hint}` : res.error));
      return;
    }
    setEditing(false);
    setFull(null);
    queryClient.setQueriesData<InfiniteData<TimelinePage>>({ queryKey: ["timeline", leadId] }, (old) =>
      old
        ? {
            ...old,
            pages: old.pages.map((p) => ({
              ...p,
              entries: p.entries.map((e) => (e.id === entry.id ? { ...e, body: draft.trim() ? draft : null, edited_at: new Date().toISOString(), truncated: false } : e)),
            })),
          }
        : old,
    );
    void queryClient.invalidateQueries({ queryKey: ["timeline", leadId] });
    toast.show(t("saved"));
  };

  const remove = async () => {
    setConfirming(false);
    if (!(await stepUp.ensureFresh(60))) return;
    let res = await deleteActivity({ id: entry.id }).catch(() => ({ ok: false as const, error: "unavailable" as const }));
    if (!res.ok && res.error === "step_up" && (await stepUp.requireFresh())) {
      res = await deleteActivity({ id: entry.id }).catch(() => ({ ok: false as const, error: "unavailable" as const }));
    }
    if (!res.ok) {
      if (res.error !== "step_up") toast.show(tErr(res.error));
      return;
    }
    queryClient.setQueriesData<InfiniteData<TimelinePage>>({ queryKey: ["timeline", leadId] }, (old) =>
      old ? { ...old, pages: old.pages.map((p) => ({ ...p, entries: p.entries.filter((e) => e.id !== entry.id) })) } : old,
    );
    refreshLead(queryClient, leadId);
    toast.show(t("deleted"));
  };

  const followUp =
    entry.task_title && (entry.task_due_date || entry.task_due_at)
      ? entry.task_done_at
        ? t("followUpDone", { date: format.dateTime(new Date(entry.task_done_at), { weekday: "short" }) })
        : t("followUp", {
            date: entry.task_due_at
              ? format.dateTime(new Date(entry.task_due_at), { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
              : format.dateTime(new Date(`${entry.task_due_date}T12:00:00Z`), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }),
          })
      : null;

  return (
    <motion.article
      initial={fresh && !reduce ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: entry.pending ? 0.6 : 1, y: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      aria-busy={entry.pending || undefined}
      className={cn("flex gap-3", compact ? "py-3" : "rounded-lg bg-card p-4")}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
        <Icon aria-hidden="true" strokeWidth={1.75} className="size-[18px]" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Under a day heading (h3) in the timeline; directly under the card's heading (h2) in Summary. */}
            <Heading className="text-sm font-bold break-words">
              {tTypes(entry.type)}
              {entry.outcome ? ` · ${tOut(entry.outcome)}` : ""}
            </Heading>
            <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
              <span>{author}</span>
              {entry.contact_name ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="rounded-sm bg-muted px-1.5 py-0.5 text-foreground">{entry.contact_name}</span>
                </>
              ) : null}
              <span aria-hidden="true">·</span>
              {entry.pending ? (
                <span>{t("saving")}</span>
              ) : (
                <time dateTime={entry.created_at} title={absolute}>
                  {now ? format.relativeTime(created, now) : format.dateTime(created, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}
                  <span className="sr-only"> ({absolute})</span>
                </time>
              )}
              {entry.edited_at ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{t("edited")}</span>
                </>
              ) : null}
            </p>
          </div>
          {!entry.pending && (entry.is_mine || canDelete) ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={t("menu")}
                className="-mt-1 -mr-1 grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground transition-[color,transform] duration-150 hover:text-foreground active:scale-[0.97] sm:size-9"
              >
                <MoreHorizontal aria-hidden="true" strokeWidth={1.75} className="size-5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                {entry.is_mine ? (
                  <DropdownMenuItem
                    onSelect={() => {
                      setDraft(full ?? entry.body ?? "");
                      setEditing(true);
                    }}
                  >
                    {t("edit")}
                  </DropdownMenuItem>
                ) : null}
                {undoSeconds > 0 ? (
                  <DropdownMenuItem onSelect={() => void undo(entry.id, leadId)}>{t("undo", { seconds: undoSeconds })}</DropdownMenuItem>
                ) : null}
                {canDelete ? (
                  <DropdownMenuItem onSelect={() => window.setTimeout(() => setConfirming(true), 0)} className="text-status-red">
                    {t("delete")}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>

        {editing ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void saveEdit();
            }}
          >
            <Textarea
              aria-label={t("editLabel")}
              value={draft}
              autoFocus
              dir="auto"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void saveEdit();
                }
                if (e.key === "Escape") setEditing(false);
              }}
              className="text-sm"
            />
            <div className="flex gap-2">
              <Button type="submit" variant="neutral" aria-disabled={saving || textLength(draft) > BODY_MAX || (entry.type === "note" && !draft.trim()) || undefined}>
                {saving ? t("saving") : t("saveEdit")}
              </Button>
              <Button variant="quiet" onClick={() => setEditing(false)}>
                {t("cancel")}
              </Button>
            </div>
          </form>
        ) : body ? (
          <div className="flex flex-col items-start gap-1">
            <p
              ref={bodyRef}
              dir="auto"
              className={cn("text-sm break-words whitespace-pre-wrap [unicode-bidi:plaintext]", !expanded && "line-clamp-6")}
            >
              {body}
              {entry.truncated && !full && expanded ? "…" : ""}
            </p>
            {!expanded && (clamped || entry.truncated) ? (
              <button type="button" onClick={() => void showMore()} className="min-h-11 text-sm font-bold underline-offset-4 hover:underline sm:min-h-0">
                {t("showMore")}
              </button>
            ) : null}
          </div>
        ) : null}

        {followUp ? (
          <span className="self-start rounded-sm bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">{followUp}</span>
        ) : null}
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className={cn(phoneSheet, "sm:w-[min(440px,calc(100%-32px))]")}>
          <div className="flex flex-col gap-5 p-6">
            <div className="flex flex-col gap-2">
              <DialogTitle className="text-xl font-bold text-balance">{t("deleteConfirm.title")}</DialogTitle>
              <DialogDescription className="text-muted-foreground">{t("deleteConfirm.body")}</DialogDescription>
            </div>
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <Button variant="quiet" onClick={() => setConfirming(false)} autoFocus>
                {t("deleteConfirm.cancel")}
              </Button>
              <Button variant="neutral" onClick={() => void remove()}>
                {t("deleteConfirm.confirm")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </motion.article>
  );
}

export function TimelineSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className="flex w-full flex-col gap-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex gap-3 rounded-lg bg-card p-4">
          <div className="size-9 shrink-0 rounded-md bg-muted motion-safe:animate-pulse" />
          <div className="flex flex-1 flex-col gap-2">
            <div className="h-4 w-1/3 rounded-sm bg-muted motion-safe:animate-pulse" />
            <div className="h-3 w-1/4 rounded-sm bg-muted motion-safe:animate-pulse" />
            <div className="h-4 w-4/5 rounded-sm bg-muted motion-safe:animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}
