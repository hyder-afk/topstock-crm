"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { motion, useReducedMotion } from "motion/react";
import { defaultRangeExtractor, useWindowVirtualizer, type Range } from "@tanstack/react-virtual";
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
import { retryKeepingFocus, timelineTarget } from "@/lib/focus";

// The lead's timeline (Day 4 design 7.2): newest first, 30 a page (keyset), grouped under Today / Yesterday / a date in
// the viewer's zone. An ordered list of articles; text is shown as text only (never HTML, never auto-linked), with
// dir="auto" so Arabic or Hebrew reads right, cut at 6 lines with Show more. Up to 120 loaded entries the whole list is
// in the page with content-visibility (design D13: the find bar and screen-reader order work as on any page). Past 120,
// D13's fallback applies, because the 1,000-entry scroll test missed 60 fps: TanStack Virtual draws only the entries near
// the window (a feed of articles with their position in the list; the find bar then sees only those). The author can
// edit the text, undo within 2 minutes and delete with a fresh code; managers and admins may delete others' entries.
/** From this many loaded entries the timeline is virtualised (design D13's fallback). */
export const VIRTUAL_FROM = 120;

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

// Memoised: it sits in a hidden Activity boundary while another tab shows, and the page draws again on each tab switch.
export const Timeline = memo(function Timeline({
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
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = query;

  // The next page loads when the end of the list comes into view; "Show older" does the same from the keyboard. After an
  // older page failed, the observer waits: the error and its Try again button show, and only a press loads again.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage || isFetchNextPageError) return;
    const observer = new IntersectionObserver(
      (items) => {
        if (items.some((i) => i.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

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
          <Button variant="quiet" onClick={(e) => void retryKeepingFocus(e.currentTarget, timelineTarget, () => query.refetch())}>
            {t("retry")}
          </Button>
        </div>
      ) : entries.length === 0 ? (
        <p className="rounded-lg bg-card p-6 text-muted-foreground">{filter === "all" ? t("empty") : t("emptyFiltered")}</p>
      ) : (
        <>
          {entries.length > VIRTUAL_FROM ? (
            <VirtualEntryList key={filter} entries={entries} leadId={leadId} me={me} stepUp={stepUp} complete={!hasNextPage} loading={isFetchingNextPage} />
          ) : (
            <EntryList key={filter} entries={entries} leadId={leadId} me={me} stepUp={stepUp} />
          )}
          <div ref={sentinel} className="flex flex-col items-start gap-2">
            {hasNextPage ? (
              isFetchNextPageError ? (
                // Stays drawn while it tries again, so the Try again button keeps focus; skeleton rows show below.
                <>
                  <div role="alert" className="flex flex-col items-start gap-3 rounded-lg bg-card p-6">
                    <p className="font-bold">{t("errorOlder")}</p>
                    <Button
                      variant="quiet"
                      aria-disabled={isFetchingNextPage || undefined}
                      className="aria-disabled:opacity-60"
                      onClick={(e) => {
                        if (!isFetchingNextPage) void retryKeepingFocus(e.currentTarget, timelineTarget, () => fetchNextPage());
                      }}
                    >
                      {t("retry")}
                    </Button>
                  </div>
                  {isFetchingNextPage ? <TimelineSkeleton rows={2} /> : null}
                </>
              ) : isFetchingNextPage ? (
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
});

// Layout reads queued for just after the next paint, run together (no read is forced between writes).
let paintQueue: (() => void)[] | null = null;
function afterPaint(read: () => void) {
  if (paintQueue) {
    paintQueue.push(read);
    return;
  }
  paintQueue = [read];
  requestAnimationFrame(() =>
    setTimeout(() => {
      const reads = paintQueue ?? [];
      paintQueue = null;
      reads.forEach((r) => r());
    }, 0),
  );
}

// The calendar day of an entry in a zone, remembered (a long list asks for each entry's day on every update).
const days = new Map<string, string>();
function dayOf(zone: string, createdAt: string) {
  const key = `${zone}|${createdAt}`;
  let day = days.get(key);
  if (day === undefined) {
    if (days.size > 5000) days.clear();
    day = localDate(zone, new Date(createdAt));
    days.set(key, day);
  }
  return day;
}

/** The day heading of an entry in the viewer's zone: Today, Yesterday or a date. */
function useDayLabel() {
  const t = useTranslations("Timeline");
  const format = useFormatter();
  const zone = useViewerZone();
  const now = useClientNow(15_000);
  const today = now ? localDate(zone, now) : null;
  // Stable while the day and the zone stay the same, so a long list works its headings out once, not on every render.
  const label = useCallback(
    (e: TimelineEntry) => {
      const day = dayOf(zone, e.created_at);
      return today && day === today
        ? t("today")
        : today && day === addDays(today, -1)
          ? t("yesterday")
          : format.dateTime(new Date(e.created_at), { weekday: "short", day: "numeric", month: "short", timeZone: zone });
    },
    [zone, today, t, format],
  );
  const day = useCallback((e: TimelineEntry) => dayOf(zone, e.created_at), [zone]);
  return { now, label, day };
}

/** Per entry, what the reader opened (Show more and its full text), kept while a virtualised row is off screen. */
type Opened = Map<string, { full: string | null }>;

/**
 * A long timeline, virtualised against the window. Each row is a day heading when the day changes, then the entry's
 * article (aria-posinset / aria-setsize in a feed). Rows keep their place by measured height; a row being edited or
 * asking to delete stays drawn when scrolled away, and what Show more opened is remembered.
 */
function VirtualEntryList({
  entries,
  leadId,
  me,
  stepUp,
  complete,
  loading,
}: {
  entries: TimelineEntry[];
  leadId: string;
  me: { id: string; role: string };
  stepUp: StepUp;
  complete: boolean;
  loading: boolean;
}) {
  const t = useTranslations("Timeline");
  const { now, label } = useDayLabel();
  const listRef = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
  const [pinned, setPinned] = useState<ReadonlySet<string>>(() => new Set());
  const [opened] = useState<Opened>(() => new Map());
  // Entries newer than the newest at the first draw were just logged: they rise in once.
  const [since] = useState(() => entries.find((e) => !e.pending)?.created_at ?? "");
  const [risen] = useState(() => new Set<string>());

  // A heading where the day changes. The day of each entry is worked out once (localDate reads the clock parts) and
  // only the first entry of a day is given its label.
  const zone = useViewerZone();
  const labels = useMemo(() => {
    const out: (string | null)[] = [];
    let previous: string | null = null;
    for (const e of entries) {
      const day = dayOf(zone, e.created_at);
      out.push(day === previous ? null : label(e));
      previous = day;
    }
    return out;
  }, [entries, label, zone]);
  const indexOf = useMemo(() => new Map(entries.map((e, i) => [e.id, i])), [entries]);

  // Where the list starts in the page (the virtualiser counts from the top of the window's scroll).
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      setMargin((m) => (Math.abs(m - top) > 0.5 ? top : m));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, []);

  const rangeExtractor = useCallback(
    (range: Range) => {
      const base = defaultRangeExtractor(range);
      if (pinned.size === 0) return base;
      const extra = [...pinned].map((id) => indexOf.get(id)).filter((i): i is number => i !== undefined && !base.includes(i));
      return extra.length ? [...base, ...extra].sort((a, b) => a - b) : base;
    },
    [pinned, indexOf],
  );
  const virtualizer = useWindowVirtualizer({
    count: entries.length,
    // Close to the drawn height (a heading, the two header lines, then about 80 characters a line up to 6 lines), so
    // fewer rows move when they are measured.
    estimateSize: (i) => (labels[i] ? 28 : 0) + 84 + 20 * Math.min(6, Math.ceil((entries[i].body?.length ?? 0) / 80)),
    overscan: 3,
    scrollMargin: margin,
    getItemKey: (i) => entries[i].id,
    rangeExtractor,
    // Measure rows on the next frame: measuring inside the ResizeObserver callback changes their size in the same frame,
    // which Safari reports as "ResizeObserver loop completed with undelivered notifications".
    useAnimationFrameWithResizeObserver: true,
    // Scrolling moves the rows and sizes the list directly in the page; React draws only when the visible range changes.
    directDomUpdates: true,
    // top, not translate3d: one compositor layer per row made each frame's layer work grow with the rows drawn.
    directDomUpdatesMode: "position",
  });
  const pin = useCallback((id: string, on: boolean) => {
    setPinned((old) => {
      if (old.has(id) === on) return old;
      const next = new Set(old);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const items = virtualizer.getVirtualItems();
  useEffect(() => {
    for (const item of items) if (entries[item.index]?.created_at > since) risen.add(entries[item.index].id);
  });

  return (
    <div
      ref={(el) => {
        listRef.current = el;
        virtualizer.containerRef(el);
      }}
      role="feed"
      aria-label={t("title")}
      aria-busy={loading || undefined}
      className="relative w-full"
    >
      {items.map((item) => {
        const e = entries[item.index];
        return (
          <div
            key={item.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            className="absolute top-0 left-0 flex w-full flex-col gap-2 pb-2"
            // Placed by the virtualiser (top); each row lays out on its own.
            style={{ contain: "layout style" }}
          >
            {labels[item.index] ? <h3 className={cn("font-mono text-xs text-muted-foreground", item.index > 0 && "pt-3")}>{labels[item.index]}</h3> : null}
            <EntryItem
              entry={e}
              leadId={leadId}
              me={me}
              stepUp={stepUp}
              now={now}
              fresh={e.created_at > since && !risen.has(e.id)}
              compact={false}
              grouped
              posInSet={item.index + 1}
              setSize={complete ? entries.length : -1}
              opened={opened}
              onPin={pin}
            />
          </div>
        );
      })}
    </div>
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
  const { now, label: dayLabel, day: dayOfEntry } = useDayLabel();
  // Entries seen at the first draw do not animate; later ones (just logged) rise in once.
  const [seen] = useState(() => new Set(entries.map((e) => e.id)));

  // Each group is keyed by its calendar day (one group in Summary), never by its first entry: a newly logged, undone or
  // deleted entry at the top would change that key and remount the group, closing an open edit and its draft.
  const groups: { key: string; day: string; label: string; items: TimelineEntry[] }[] = [];
  const used = new Map<string, number>();
  for (const e of entries) {
    const day = dayOfEntry(e);
    const last = groups[groups.length - 1];
    if (last && (!grouped || last.day === day)) last.items.push(e);
    else {
      // Newest first, so a day comes once; a clock-skewed optimistic entry could bring it back, and keys stay unique.
      const n = used.get(day) ?? 0;
      used.set(day, n + 1);
      groups.push({ key: grouped ? (n ? `${day}~${n}` : day) : "all", day, label: dayLabel(e), items: [e] });
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {groups.map((g) => (
        <div key={g.key} className="flex flex-col gap-2">
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

// Memoised: a virtualised list draws again on every scroll frame, and only rows whose entry changed need to.
const EntryItem = memo(function EntryItem({
  entry,
  leadId,
  me,
  stepUp,
  now,
  fresh,
  compact,
  grouped,
  posInSet,
  setSize,
  opened,
  onPin,
}: {
  entry: TimelineEntry;
  leadId: string;
  me: { id: string; role: string };
  stepUp: StepUp;
  now: Date | null;
  fresh: boolean;
  compact: boolean;
  grouped: boolean;
  /** In a virtualised feed: the entry's place, and the list's length (-1 while older entries are still to load). */
  posInSet?: number;
  setSize?: number;
  /** In a virtualised feed: what Show more opened, kept while the row is off screen. */
  opened?: Opened;
  /** In a virtualised feed: keep this row drawn while it is being edited or asks to delete. */
  onPin?: (id: string, on: boolean) => void;
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
  const [expanded, setExpanded] = useState(() => opened?.has(entry.id) ?? false);
  const [full, setFull] = useState<string | null>(() => opened?.get(entry.id)?.full ?? null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [askedOnce, setAskedOnce] = useState(false);
  if (confirming && !askedOnce) setAskedOnce(true);
  const bodyRef = useRef<HTMLParagraphElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const editChosen = useRef(false);
  const refocus = useRef(false);
  const [clamped, setClamped] = useState(false);
  const Icon = typeIcon[entry.type];
  const Heading = grouped ? "h4" : "h3";
  const author = entry.is_mine ? t("you") : personName({ first_name: entry.user_first_name, last_name: entry.user_last_name }) || t("someone");
  const created = new Date(entry.created_at);
  const absolute = format.dateTime(created, { dateStyle: "full", timeStyle: "short" });
  const canDelete = !entry.pending && (entry.is_mine || me.role === "admin" || me.role === "manager");
  const undoSeconds = now ? undoLeft(entry, now.getTime()) : 0;
  const body = full ?? entry.body;

  // Whether the text is cut at 6 lines (then Show more appears). Read just after a frame is painted, all entries in one
  // batch, when the page's layout is up to date: reading scrollHeight in an effect forced a layout per entry (about 14 ms
  // each at 4x CPU). A ResizeObserver asks again when the width changes.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    let live = true;
    const read = () => live && setClamped(el.scrollHeight > el.clientHeight + 1);
    const observer = new ResizeObserver(() => afterPaint(read));
    observer.observe(el);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [body, expanded]);

  // A cut entry asks for its full text first. If that fails (an error answer or offline), the entry stays closed with
  // Show more still there to try again, and a toast says why.
  const showMore = async () => {
    let text = full;
    if (entry.truncated && full === null) {
      try {
        const res = await fetch(`/api/activities/${entry.id}`, { headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(String(res.status));
        text = ((await res.json()) as { body: string | null }).body;
      } catch {
        toast.show(t("showMoreError"));
        return;
      }
      setFull(text);
    }
    setExpanded(true);
    opened?.set(entry.id, { full: text });
  };

  // Escape, Cancel or a save closes the inline edit and unmounts what had focus: focus goes back to the entry's options
  // button (where the edit began), after commit, unless the reader has since moved focus somewhere else.
  const endEdit = () => {
    const active = document.activeElement;
    refocus.current = !active || active === document.body || !!formRef.current?.contains(active);
    setEditing(false);
  };
  useEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    menuRef.current?.focus();
  }, [editing]);

  // A virtualised row stays drawn while it is being edited or asks to delete (the draft and the dialog live here).
  const busy = editing || confirming;
  useEffect(() => {
    if (!onPin) return;
    onPin(entry.id, busy);
    return () => onPin(entry.id, false);
  }, [onPin, entry.id, busy]);

  const saveEdit = async () => {
    setSaving(true);
    const res = await editActivity({ id: entry.id, body: draft }).catch(() => ({ ok: false as const, error: "unavailable" as const }));
    setSaving(false);
    if (!res.ok) {
      toast.show(tErr("hint" in res && res.hint ? `hint.${res.hint}` : res.error));
      return;
    }
    endEdit();
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

  // Only a just-logged entry rises in (Motion); the others are plain articles, which mount far faster while scrolling.
  const shell = {
    "aria-busy": entry.pending || undefined,
    "aria-posinset": posInSet,
    "aria-setsize": setSize,
    className: cn("flex gap-3 transition-opacity duration-200", compact ? "py-3" : "rounded-lg bg-card p-4", entry.pending && !fresh && "opacity-60"),
  };
  const inner = (
    <>
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
            <EntryMenu
              label={t("menu")}
              triggerRef={menuRef}
              // Picking Edit text: the menu closes into the text box, not back to its button (Radix's default).
              onCloseAutoFocus={(e) => {
                if (!editChosen.current) return;
                editChosen.current = false;
                e.preventDefault();
                textRef.current?.focus();
              }}
            >
              {entry.is_mine ? (
                <DropdownMenuItem
                  onSelect={() => {
                    editChosen.current = true;
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
            </EntryMenu>
          ) : null}
        </div>

        {editing ? (
          <form
            ref={formRef}
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void saveEdit();
            }}
          >
            <Textarea
              ref={textRef}
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
                if (e.key === "Escape") endEdit();
              }}
              className="text-sm"
            />
            <div className="flex gap-2">
              <Button type="submit" variant="neutral" aria-disabled={saving || textLength(draft) > BODY_MAX || (entry.type === "note" && !draft.trim()) || undefined}>
                {saving ? t("saving") : t("saveEdit")}
              </Button>
              <Button variant="quiet" onClick={endEdit}>
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

      {/* Mounted from the first time it opens (then kept, so it can animate closed): a closed dialog per entry is not free. */}
      {askedOnce ? (
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
      ) : null}
    </>
  );

  return (
    fresh && !reduce ? (
      <motion.article
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: entry.pending ? 0.6 : 1, y: 0 }}
        transition={{ type: "spring", stiffness: 300, damping: 30 }}
        {...shell}
      >
        {inner}
      </motion.article>
    ) : (
      <article {...shell}>{inner}</article>
    )
  );
});

const menuTrigger =
  "-mt-1 -mr-1 grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground transition-[color,transform] duration-150 hover:text-foreground active:scale-[0.97] sm:size-9";

/**
 * An entry's menu. Until it is first used it is a plain button (a menu per entry, 30 a page, cost the tab switch and the
 * scroll real time); a press or Enter, Space or Down turns it into the menu, opened, which keeps focus inside as usual
 * and gives it back to its button when it closes.
 */
function EntryMenu({
  label,
  triggerRef,
  onCloseAutoFocus,
  children,
}: {
  label: string;
  triggerRef?: React.Ref<HTMLButtonElement>;
  onCloseAutoFocus?: (e: Event) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState<boolean | null>(null);
  const icon = <MoreHorizontal aria-hidden="true" strokeWidth={1.75} className="size-5" />;
  if (open === null) {
    return (
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={false}
        className={menuTrigger}
        onPointerDown={(e) => {
          if (e.button !== 0 || e.ctrlKey) return;
          e.preventDefault();
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " " && e.key !== "ArrowDown") return;
          e.preventDefault();
          setOpen(true);
        }}
      >
        {icon}
      </button>
    );
  }
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger ref={triggerRef} aria-label={label} className={menuTrigger}>
        {icon}
      </DropdownMenuTrigger>
      <DropdownMenuContent onCloseAutoFocus={onCloseAutoFocus}>{children}</DropdownMenuContent>
    </DropdownMenu>
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
