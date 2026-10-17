"use client";

import { Activity, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { useStepUp } from "@/components/auth/step-up-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, phoneSheet } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip } from "@/components/ui/tooltip";
import { TabList, TabPanel, panelId } from "@/components/ui/tabs";
import { Composer, type ComposerMode } from "@/components/activity/composer";
import { EntryList, Timeline } from "@/components/activity/timeline";
import { fetchTimeline, timelineKey, useTimeline } from "@/components/activity/use-activities";
import { fetchLead, leadKey, rowBefore, useLeadChanges } from "@/components/leads/use-leads";
import { DetailsTab } from "@/components/lead/details-tab";
import { prefetchFiles } from "@/components/files/use-files";
import { Card, ContactsCard, NextStepCard } from "@/components/lead/lead-cards";
import { LeadHeader } from "@/components/lead/lead-header";
import { listNeighbours, readListReturn } from "@/components/lead/lead-nav";
import { QuickActions } from "@/components/lead/quick-actions";
import { DealChip } from "@/components/lead/deal-chip";
import { DealSummaryCard } from "@/components/lead/deal-summary-card";
import { DealsTab } from "@/components/lead/deals-tab";
import { useDealFlows } from "@/components/pipeline/deal-flows";
import { DealSheet } from "@/components/pipeline/deal-sheet";
import { OpenDealSheet } from "@/components/pipeline/open-deal-sheet";
import type { DealCard } from "@/lib/deals";
import { fetchLeadDealsClient, leadDealsKey } from "@/lib/prefetch";
import type { TimelineFilter, TimelinePage } from "@/lib/activities";
import { LEAD_TABS, personName, type LeadDetail, type LeadStatus, type LeadTab, type TeamMember } from "@/lib/leads";
import { isTyping } from "@/lib/shortcuts";
import type { LeadTask } from "@/lib/tasks";
import type { FilesPage } from "@/lib/files/types";
import { cardTitle, retryKeepingFocus } from "@/lib/focus";

// The Stock (Day 6) and Files (Day 4d) tabs load their code when first shown (a deep link to ?tab=stock or ?tab=files,
// a click, a shortcut), not with the page: the lead page's own JavaScript stays inside its 60 KB budget (design 8.6).
// Pointing at or focusing the tab fetches the code ahead (prefetchTab), as it does the tab's data. While the code
// arrives the panel shows the body's card skeleton (no spinner).
const loadStockTab = () => import("@/components/lead/stock-tab");
const loadFilesTab = () => import("@/components/files/files-tab");
function PanelSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-4">
      <div className="h-32 rounded-lg bg-card motion-safe:animate-pulse" />
      <div className="h-64 rounded-lg bg-card motion-safe:animate-pulse" />
    </div>
  );
}
const LeadStockTab = dynamic(() => loadStockTab().then((m) => m.LeadStockTab), { ssr: false, loading: PanelSkeleton });
const FilesTab = dynamic(() => loadFilesTab().then((m) => m.FilesTab), { ssr: false, loading: PanelSkeleton });

// The lead page (Day 4 design 7.1). Server-rendered with the lead, the first timeline page and its tasks; the browser
// keeps them in the query cache (shared with the leads preview). 1440: the header full width with the actions on the
// right, then the tabs, then a two-column body (the tab, and a sticky rail with the composer and the contacts; the next
// step with the open tasks leads Summary). 390: a back link, the header stacked, five equal actions, the tabs as a
// sideways strip; the contacts fold into Summary and the composer opens as a sheet. J and K move to the next or previous lead of the list it was
// opened from; Back returns to that list where it was. Files (Day 4d, design 7.6) lists, adds, opens and deletes files.
// Each tab's panel sits in a React Activity boundary: the selected one is shown, the others are drawn in the background
// at low priority (hidden, effects off), so a tab switch only reveals a panel that is ready (design 8.6: 100 ms), and a
// panel keeps its state (scroll in the timeline, a half-typed detail) when the reader comes back to it.

const wide = "(min-width: 1024px)";
const noopSubscribe = () => () => {};
function subscribeWide(cb: () => void) {
  const mq = window.matchMedia(wide);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

// The lead as the leads list's change helpers expect it (for their optimistic update and Undo).
function beforeOf(lead: LeadDetail) {
  return rowBefore({
    id: lead.id,
    lead_status: lead.lead_status,
    owner_id: lead.owner?.id ?? null,
    owner_first_name: lead.owner?.first_name ?? null,
    owner_last_name: lead.owner?.last_name ?? null,
  });
}

export function LeadPage({
  initialLead,
  initialTimeline,
  initialTasks,
  initialFiles,
  team,
  me,
  stepUpSeconds,
  initialTab,
  initialFilter,
  initialDeal = null,
}: {
  initialLead: LeadDetail;
  initialTimeline: TimelinePage | null;
  initialTasks: LeadTask[] | null;
  initialFiles: FilesPage | null;
  team: TeamMember[];
  me: { id: string; role: TeamMember["role"] };
  stepUpSeconds: number;
  initialTab: LeadTab;
  initialFilter: TimelineFilter;
  initialDeal?: string | null;
}) {
  const t = useTranslations("LeadPage");
  const tLeads = useTranslations("Leads");
  const tTimeline = useTranslations("Timeline");
  const format = useFormatter();
  const router = useRouter();
  const queryClient = useQueryClient();
  const id = initialLead.id;
  const leadQuery = useQuery({ queryKey: leadKey(id), queryFn: () => fetchLead(id), initialData: initialLead });
  const lead = leadQuery.data;
  const timeline = useTimeline(id, "all", initialTimeline);
  const stepUpHook = useStepUp(stepUpSeconds, "bodyDelete");
  // The same object between renders, so the memoised timeline rows do not draw again when the page does.
  const { ensureFresh, requireFresh } = stepUpHook;
  const stepUp = useMemo(() => ({ ensureFresh, requireFresh }), [ensureFresh, requireFresh]);
  const { changeStatus, changeOwner } = useLeadChanges(team);
  const isWide = useSyncExternalStore(subscribeWide, () => window.matchMedia(wide).matches, () => true);
  const [tab, setTabState] = useState<LeadTab>(initialTab);
  // The tabs shown so far: a lazily loaded tab mounts on its first showing and then stays (hidden, with its state).
  const [seen, setSeen] = useState<ReadonlySet<LeadTab>>(() => new Set([initialTab]));
  if (!seen.has(tab)) setSeen(new Set(seen).add(tab));
  const [mode, setMode] = useState<ComposerMode | null>(null);
  const [sheet, setSheet] = useState(false);
  // A quick action is used once: it is cleared when the sheet closes and when the window crosses 1024 px (an iPad
  // turning, Split View), so the composer that mounts next does not apply an old request over the draft's kind.
  const [modeWide, setModeWide] = useState(isWide);
  if (modeWide !== isWide) {
    setModeWide(isWide);
    setMode(null);
  }
  const [nav, setNav] = useState<ReturnType<typeof listNeighbours>>(null);
  const [backUrl, setBackUrl] = useState("/leads");
  const canAssign = me.role === "admin" || me.role === "manager";
  // Day 5b (design 7.9): the deal sheet over the page (?deal=), New deal, and the Win/Lose/Reopen/Delete dialogs.
  const dealFlows = useDealFlows(stepUpSeconds, "recent", { undoKey: true });
  const [dealSheet, setDealSheet] = useState<string | null>(initialDeal);
  const [newDeal, setNewDeal] = useState(false);
  const openDealSheet = useCallback((dealId: string | null) => {
    setDealSheet(dealId);
    const url = new URL(window.location.href);
    if (dealId) url.searchParams.set("deal", dealId);
    else url.searchParams.delete("deal");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
  }, []);
  // Reopen from the Deals tab: the stage the deal was closed from (design 7.6, from its history), then the focus goes
  // to the deal's row in the Open section (its row menu went with the closed row).
  const reopenDeal = useCallback(
    (deal: DealCard, done?: (ok: boolean) => void) => void dealFlows.reopenFromHistory(deal, done),
    [dealFlows],
  );

  // The list this lead was opened from (this tab only): Back, J/K and "3 of 1,204". Read once in the browser (storage
  // and the list's cache are not on the server), during render as React suggests for outside state.
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const [navFor, setNavFor] = useState<string | null>(null);
  if (mounted && navFor !== id) {
    setNavFor(id);
    setNav(listNeighbours(queryClient, id));
    setBackUrl(readListReturn()?.url ?? "/leads");
  }
  useEffect(() => {
    if (nav?.next) router.prefetch(`/leads/${nav.next}`);
    if (nav?.previous) router.prefetch(`/leads/${nav.previous}`);
  }, [nav, router]);

  const setTab = useCallback((next: LeadTab) => {
    setTabState(next);
    const url = new URL(window.location.href);
    if (next === "summary") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
  }, []);

  const showDetails = useCallback(
    (focus?: "timezone" | "country" | "next") => {
      setTab("details");
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const panel = document.getElementById(panelId(`lead-${id}`, "details"));
          const target = focus ? panel?.querySelector<HTMLElement>(`[data-focus=${focus}]`) : null;
          // The app's pickers put data-focus on a group (date + time) or a trigger: focus the first control inside.
          const el = target && !target.matches("button, input, [tabindex]") ? target.querySelector<HTMLElement>("button, input, [tabindex]") : target;
          (el ?? panel)?.focus();
        }),
      );
    },
    [setTab, id],
  );

  const openComposer = useCallback(
    (kind: "note" | "meeting") => {
      setMode({ type: kind, meeting: kind === "meeting" ? "book" : undefined, nonce: Date.now() });
      if (!window.matchMedia(wide).matches) setSheet(true);
    },
    [],
  );

  const showNext = useCallback(() => showDetails("next"), [showDetails]);
  const toggleSheet = useCallback((open: boolean) => {
    setSheet(open);
    if (!open) setMode(null);
  }, []);
  const closeSheet = useCallback(() => toggleSheet(false), [toggleSheet]);
  const onStatus = useCallback(
    (status: LeadStatus, returnAt: string | null) => void (lead && changeStatus([beforeOf(lead)], status, returnAt)),
    [changeStatus, lead],
  );
  const onOwner = useCallback((ownerId: string | null) => void (lead && changeOwner([beforeOf(lead)], ownerId)), [changeOwner, lead]);

  // J and K: the next and previous lead of the same list (quiet while typing, in a dialog, or with a modifier).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (document.querySelector("[role=dialog]")) return;
      const target = event.key === "j" ? nav?.next : event.key === "k" ? nav?.previous : null;
      if (!target) return;
      event.preventDefault();
      router.push(`/leads/${target}`);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [nav, router]);

  if (!lead) {
    return (
      <div className="flex flex-col items-start gap-4 pt-4">
        <h1 className="text-2xl font-bold">{t("goneTitle")}</h1>
        <p className="text-muted-foreground">{tLeads("preview.notFound")}</p>
        <Link href={backUrl} className="font-bold underline-offset-4 hover:underline active:opacity-60">
          {t("back")}
        </Link>
      </div>
    );
  }

  const entries = timeline.data?.pages[0]?.entries ?? [];
  const recent = entries.slice(0, 3);
  const latestCall = entries.find((e) => e.type === "call" && !e.pending) ?? null;
  const dncEntry = entries.find((e) => e.outcome === "do_not_contact") ?? null;
  const dnc = lead.lead_status === "do_not_contact";
  const ownerName = lead.owner ? personName(lead.owner) || tLeads("noName") : null;
  const tabs = LEAD_TABS.map((tabId) => ({ id: tabId, label: t(`tabs.${tabId}`) }));
  const prefetchTab = (tabId: LeadTab) => {
    if (tabId === "deals") {
      void queryClient.prefetchQuery({ queryKey: leadDealsKey(id), queryFn: () => fetchLeadDealsClient(id), staleTime: 30_000 });
    }
    if (tabId === "timeline") {
      void queryClient.prefetchInfiniteQuery({
        queryKey: timelineKey(id, "all"),
        queryFn: ({ pageParam }) => fetchTimeline(id, "all", pageParam as TimelinePage["next"]),
        initialPageParam: null as TimelinePage["next"],
        staleTime: 30_000,
      });
    }
    if (tabId === "files") {
      void prefetchFiles(queryClient, id);
      void loadFilesTab();
    }
    if (tabId === "stock") void loadStockTab();
  };

  const composerCard = (
    <Card title={t("composerTitle")}>
      <Composer lead={lead} mode={isWide ? mode : null} />
    </Card>
  );

  return (
    <div className="flex min-w-0 flex-col gap-5 pt-2">
      <div className="flex min-h-11 items-center justify-between gap-3">
        <Link
          href={backUrl}
          className="-ml-2 inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm text-muted-foreground transition-[color,transform,scale] duration-150 hover:text-foreground active:scale-[0.97]"
        >
          <ArrowLeft aria-hidden="true" strokeWidth={1.75} className="size-4" />
          {t("back")}
        </Link>
        {nav ? (
          <div className="flex items-center gap-1 text-sm text-muted-foreground">
            <span className="font-mono">{t("position", { index: format.number(nav.index + 1), total: format.number(nav.total) })}</span>
            <Tooltip content={t("previousKey")}>
              <Link
                href={nav.previous ? `/leads/${nav.previous}` : "#"}
                aria-disabled={!nav.previous || undefined}
                aria-label={t("previous")}
                onClick={(e) => !nav.previous && e.preventDefault()}
                className="grid size-11 place-items-center rounded-md transition-[color,transform,scale] duration-150 hover:text-foreground active:scale-[0.97] aria-disabled:opacity-40 sm:size-9"
              >
                <ChevronLeft aria-hidden="true" strokeWidth={1.75} className="size-5" />
              </Link>
            </Tooltip>
            <Tooltip content={t("nextKey")}>
              <Link
                href={nav.next ? `/leads/${nav.next}` : "#"}
                aria-disabled={!nav.next || undefined}
                aria-label={t("next")}
                onClick={(e) => !nav.next && e.preventDefault()}
                className="grid size-11 place-items-center rounded-md transition-[color,transform,scale] duration-150 hover:text-foreground active:scale-[0.97] aria-disabled:opacity-40 sm:size-9"
              >
                <ChevronRight aria-hidden="true" strokeWidth={1.75} className="size-5" />
              </Link>
            </Tooltip>
            <span className="hidden gap-1 lg:inline-flex" aria-hidden="true">
              <Kbd>J</Kbd>
              <Kbd>K</Kbd>
            </span>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <LeadHeader
            lead={lead}
            team={team}
            canAssign={canAssign}
            latestCall={latestCall}
            onStatus={onStatus}
            onOwner={onOwner}
            onShowDetails={showDetails}
          />
          <div className="sm:pl-14">
            <DealChip lead={lead} onShow={() => setTab("deals")} />
          </div>
        </div>
        {dnc ? (
          <div role="note" className="flex max-w-md items-start gap-2 rounded-lg bg-card p-4 text-sm xl:shrink-0">
            <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-status-red" />
            <span>
              {dncEntry
                ? t("dncBannerBy", {
                    name: dncEntry.is_mine ? t("you") : personName({ first_name: dncEntry.user_first_name, last_name: dncEntry.user_last_name }) || t("someone"),
                    date: format.dateTime(new Date(dncEntry.created_at), { day: "numeric", month: "short" }),
                  })
                : t("dncBanner")}
            </span>
          </div>
        ) : (
          <div className="xl:shrink-0">
            <QuickActions lead={lead} onComposer={openComposer} onShowDetails={showNext} />
          </div>
        )}
      </div>
      {/* Do not contact: the quick actions (with Note) give way to the banner, so below desktop width, where there is no
          rail composer, this opens the sheet's composer (notes, calls and meetings stay loggable at every width). */}
      {dnc ? (
        <div className="flex gap-2 lg:hidden">
          <Button variant="quiet" onClick={() => openComposer("note")}>
            {t("addNote")}
          </Button>
        </div>
      ) : null}

      {!lead.can_edit ? (
        <p className="text-sm text-muted-foreground">
          {ownerName ? tLeads("preview.readOnly", { owner: ownerName }) : tLeads("preview.readOnlyUnowned")}
        </p>
      ) : null}

      <TabList items={tabs} value={tab} onChange={setTab} onIntent={prefetchTab} label={t("tabsLabel")} idBase={`lead-${id}`} />

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        <div className="min-w-0">
          <Activity mode={tab === "summary" ? "visible" : "hidden"}>
            <TabPanel idBase={`lead-${id}`} id="summary" className="flex min-w-0 flex-col gap-4">
              <NextStepCard lead={lead} initialTasks={initialTasks} onChangeNext={showNext} />
              <div className="flex flex-col gap-4 lg:hidden">
                <ContactsCard lead={lead} readOnlyContact={false} />
              </div>
              <Card
                title={t("recent")}
                action={
                  entries.length > 0 ? (
                    <Button variant="link" className="min-h-11 text-sm sm:min-h-9" onClick={() => setTab("timeline")}>
                      {t("seeTimeline")}
                    </Button>
                  ) : null
                }
              >
                {timeline.isPending ? (
                  <div aria-hidden="true" className="h-20 rounded-md bg-muted motion-safe:animate-pulse" />
                ) : timeline.isError && entries.length === 0 ? (
                  <div role="alert" className="flex flex-col items-start gap-2">
                    <p className="text-sm font-bold">{tTimeline("error")}</p>
                    <Button variant="quiet" onClick={(e) => void retryKeepingFocus(e.currentTarget, cardTitle, () => timeline.refetch())}>
                      {tTimeline("retry")}
                    </Button>
                  </div>
                ) : entries.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("noEntries")}</p>
                ) : (
                  <EntryList entries={recent} leadId={id} me={me} stepUp={stepUp} grouped={false} compact />
                )}
              </Card>
              <DealSummaryCard lead={lead} onOpenDeal={openDealSheet} onNewDeal={() => setNewDeal(true)} onShowDeals={() => setTab("deals")} />
            </TabPanel>
          </Activity>
          <Activity mode={tab === "timeline" ? "visible" : "hidden"}>
            <TabPanel idBase={`lead-${id}`} id="timeline" className="flex min-w-0 flex-col gap-4">
              <Timeline leadId={id} initial={initialTimeline} initialFilter={initialFilter} me={me} stepUp={stepUp} />
            </TabPanel>
          </Activity>
          <Activity mode={tab === "deals" ? "visible" : "hidden"}>
            <TabPanel idBase={`lead-${id}`} id="deals" className="flex min-w-0 flex-col gap-4">
              <DealsTab lead={lead} onOpenDeal={openDealSheet} onNewDeal={() => setNewDeal(true)} onReopen={reopenDeal} />
            </TabPanel>
          </Activity>
          <Activity mode={tab === "stock" ? "visible" : "hidden"}>
            <TabPanel idBase={`lead-${id}`} id="stock" className="flex min-w-0 flex-col gap-4">
              {seen.has("stock") ? (
                <LeadStockTab
                  lead={{ id, name: lead.name, country: lead.country, phone: lead.phone, email: lead.email }}
                  me={me.id}
                  meFirstName={team.find((m) => m.id === me.id)?.first_name ?? null}
                  role={me.role}
                  active={tab === "stock"}
                  stepUp={stepUp}
                />
              ) : null}
            </TabPanel>
          </Activity>
          <Activity mode={tab === "files" ? "visible" : "hidden"}>
            <TabPanel idBase={`lead-${id}`} id="files" className="flex min-w-0 flex-col gap-4">
              {seen.has("files") ? <FilesTab leadId={id} initial={initialFiles} stepUp={stepUp} /> : null}
            </TabPanel>
          </Activity>
          <Activity mode={tab === "details" ? "visible" : "hidden"}>
            <TabPanel idBase={`lead-${id}`} id="details" className="flex min-w-0 flex-col gap-4">
              <DetailsTab lead={lead} team={team} canAssign={canAssign} />
            </TabPanel>
          </Activity>
        </div>
        <aside aria-label={t("railLabel")} className="hidden min-w-0 flex-col gap-4 lg:sticky lg:top-4 lg:flex">
          {/* One composer at a time (it holds the draft): the rail's from desktop width, the sheet's below. */}
          {isWide ? composerCard : null}
          <ContactsCard lead={lead} readOnlyContact={false} />
        </aside>
      </div>

      {/* Phones and tablets: the composer as a sheet (Note, Meeting). */}
      <Dialog open={sheet && !isWide} onOpenChange={toggleSheet}>
        <DialogContent className={`${phoneSheet} max-h-[calc(100dvh-24px)] overflow-y-auto overscroll-contain sm:w-[min(520px,calc(100%-32px))]`}>
          <div className="flex flex-col gap-4 p-5 sm:p-6">
            <DialogTitle className="text-xl font-bold">{t("composerTitle")}</DialogTitle>
            <DialogDescription className="sr-only">{t("composerBody", { lead: lead.name })}</DialogDescription>
            <Composer lead={lead} mode={mode} onSaved={closeSheet} />
          </div>
        </DialogContent>
      </Dialog>
      {stepUpHook.dialog}
      <DealSheet dealId={dealSheet} onClose={() => openDealSheet(null)} flows={dealFlows} team={team} canAssign={canAssign} />
      <OpenDealSheet
        open={newDeal}
        initialLead={{ id: lead.id, name: lead.name }}
        onClose={() => setNewDeal(false)}
        onOpened={(dealId) => {
          setNewDeal(false);
          setTab("deals");
          openDealSheet(dealId);
        }}
        onOpenExisting={(dealId) => {
          setNewDeal(false);
          openDealSheet(dealId);
        }}
        actions={dealFlows.actions}
        team={team}
        canAssign={canAssign}
        meId={me.id}
      />
      {dealFlows.dialogs}
    </div>
  );
}
