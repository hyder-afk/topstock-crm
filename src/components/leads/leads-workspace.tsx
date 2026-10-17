"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import type { RowSelectionState } from "@tanstack/react-table";
import Link from "next/link";
import { Headset, Plus, Upload, Users } from "lucide-react";
import { createLead } from "@/app/(app)/leads/actions";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/toast";
import { LeadForm, emptyLead } from "@/components/leads/lead-form";
import { LeadPreview } from "@/components/leads/lead-preview";
import { LeadsTable } from "@/components/leads/leads-table";
import { LeadsToolbar } from "@/components/leads/leads-toolbar";
import { prefetchLead } from "@/components/activity/use-activities";
import { saveListReturn } from "@/components/lead/lead-nav";
import { rowBefore, useLeadChanges, useLeads } from "@/components/leads/use-leads";
import {
  activeFilterCount,
  filtersToParams,
  leadStatuses,
  optionalColumns,
  parseFilters,
  personName,
  type LeadFilters,
  type LeadPage,
  type OptionalColumn,
  type TeamMember,
} from "@/lib/leads";
import type { SavedView } from "@/lib/leads-server";
import { isTyping } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

const columnsKey = "topstock.leads.hidden-columns";
const defaultHidden: OptionalColumn[] = ["phone", "email"];

// Hidden columns are a per-person convenience kept in this browser (DESIGN/CLAUDE: never business data there).
function readHidden(): OptionalColumn[] {
  try {
    const raw = window.localStorage.getItem(columnsKey);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) return parsed.filter((c): c is OptionalColumn => (optionalColumns as readonly string[]).includes(c));
  } catch {
    // Storage blocked (private window): use the default.
  }
  return defaultHidden;
}
const hiddenListeners = new Set<() => void>();
let hiddenCache: OptionalColumn[] | null = null;
function subscribeHidden(cb: () => void) {
  hiddenListeners.add(cb);
  return () => hiddenListeners.delete(cb);
}
function getHidden() {
  hiddenCache ??= readHidden();
  return hiddenCache;
}
function setHiddenStore(next: OptionalColumn[]) {
  hiddenCache = next;
  try {
    window.localStorage.setItem(columnsKey, JSON.stringify(next));
  } catch {
    // Not saved; still applies for this visit.
  }
  hiddenListeners.forEach((l) => l());
}

// The URL mirrors the filters and the open lead (shareable, survives reload, Back and Forward work). Next.js keeps
// useSearchParams in sync with history.replaceState/pushState, so no server round trip happens on a change.
type UiState = { filters: LeadFilters; lead: string | null };
const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stateFromParams(params: URLSearchParams): UiState {
  const lead = params.get("lead");
  return { filters: parseFilters(params), lead: lead && uuidLike.test(lead) ? lead : null };
}
function urlFor(state: UiState) {
  const params = filtersToParams(state.filters);
  if (state.lead) params.set("lead", state.lead);
  const qs = params.toString();
  return `/leads${qs ? `?${qs}` : ""}`;
}

export function LeadsWorkspace({
  initialKey,
  initialPage,
  team,
  initialViews,
  me,
}: {
  initialKey: string;
  initialPage: LeadPage | null;
  team: TeamMember[];
  initialViews: SavedView[];
  me: { id: string; role: TeamMember["role"] };
}) {
  const t = useTranslations("Leads");
  const tForm = useTranslations("Leads.form");
  const tStatus = useTranslations("Leads.status");
  const format = useFormatter();
  const toast = useToast();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  // Filters and the open lead live in React state (a tick or a click shows at once, under 100 ms) and are written
  // to the URL; when the URL changes from outside (Back, Forward), the state follows it.
  const [ui, setUi] = useState(() => stateFromParams(searchParams));
  const urlKey = searchParams.toString();
  const [seenKey, setSeenKey] = useState(urlKey);
  if (urlKey !== seenKey) {
    setSeenKey(urlKey);
    const fromUrl = stateFromParams(searchParams);
    if (urlFor(fromUrl) !== urlFor(ui)) setUi(fromUrl);
  }
  const { filters, lead: activeId } = ui;
  const navigate = useCallback((next: UiState, mode: "push" | "replace") => {
    setUi(next);
    if (mode === "push") window.history.pushState(null, "", urlFor(next));
    else window.history.replaceState(null, "", urlFor(next));
  }, []);
  const canAssign = me.role === "admin" || me.role === "manager";
  const isAdmin = me.role === "admin";

  const [views, setViews] = useState(initialViews);
  const [adding, setAdding] = useState(false);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const hidden = useSyncExternalStore(subscribeHidden, getHidden, () => defaultHidden);
  const columnVisibility = useMemo(() => Object.fromEntries(optionalColumns.map((c) => [c, !hidden.includes(c)])), [hidden]);

  const query = useLeads(filters, { key: initialKey, page: initialPage });
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.rows) ?? [], [query.data]);
  const total = query.data?.pages[0]?.total ?? null;
  const { changeStatus, changeOwner } = useLeadChanges(team);

  const setFilters = useCallback(
    (next: LeadFilters) => {
      setRowSelection({});
      navigate({ filters: next, lead: activeId }, "replace");
    },
    [activeId, navigate],
  );
  // The full lead page (Day 4b): remembers this list's URL, query and scroll position for Back and J/K.
  const router = useRouter();
  const rememberList = useCallback(() => {
    const scroll = document.querySelector<HTMLElement>("[data-leads-scroll]")?.scrollTop ?? 0;
    saveListReturn({ url: urlFor(ui), key: filtersToParams(filters).toString(), scroll });
  }, [ui, filters]);
  const openPage = useCallback(
    (id: string) => {
      rememberList();
      router.push(`/leads/${id}`);
    },
    [rememberList, router],
  );
  // Below desktop width a tap opens the lead page; on desktop the preview opens beside the list.
  const openLead = useCallback(
    (id: string) => {
      if (!window.matchMedia("(min-width: 1024px)").matches) openPage(id);
      else navigate({ filters, lead: id }, activeId ? "replace" : "push");
    },
    [filters, activeId, navigate, openPage],
  );
  const closeLead = useCallback(() => navigate({ filters, lead: null }, "replace"), [filters, navigate]);
  // Hover intent (120 ms on a row): the lead, its first timeline page and the lead page's code are fetched ahead.
  const intent = useRef<number | null>(null);
  const prefetch = useCallback(
    (id: string) => {
      if (intent.current !== null) window.clearTimeout(intent.current);
      intent.current = window.setTimeout(() => {
        intent.current = null;
        prefetchLead(queryClient, id);
        router.prefetch(`/leads/${id}`);
      }, 120);
    },
    [queryClient, router],
  );
  useEffect(() => () => {
    if (intent.current !== null) window.clearTimeout(intent.current);
  }, []);
  // O opens the lead shown in the preview as a full page (quiet while typing or in a dialog).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "o" || !activeId || event.defaultPrevented || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target) || document.querySelector("[role=dialog]")) return;
      event.preventDefault();
      openPage(activeId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeId, openPage]);

  const selectedRows = rows.filter((r) => rowSelection[r.id]);
  const before = selectedRows.map(rowBefore);
  const filtered = activeFilterCount(filters) > 0 || !!filters.q;

  let body: React.ReactNode;
  if (query.isPending) body = <TableSkeleton />;
  else if (query.isError && rows.length === 0)
    body = (
      <StatePanel title={t("errorTitle")} text={t("errorBody")} role="alert">
        <Button variant="quiet" onClick={() => void query.refetch()}>
          {t("retry")}
        </Button>
      </StatePanel>
    );
  else if (rows.length === 0)
    body = filtered ? (
      <StatePanel title={t("noMatchTitle")} text={t("noMatchBody")}>
        <Button variant="quiet" onClick={() => setFilters({ sort: filters.sort })}>
          {t("clearFilters")}
        </Button>
      </StatePanel>
    ) : (
      <StatePanel title={t("emptyTitle")} text={isAdmin ? t("emptyBody") : t("emptyBodyRep")} icon>
        <div className="flex flex-wrap gap-3">
          {isAdmin ? (
            // The header's Add is this screen's one red primary action, so the empty state's Import is the secondary.
            <Link href="/leads/import" className={buttonVariants({ variant: "quiet" })}>
              <Upload aria-hidden="true" strokeWidth={2} className="size-4" />
              {t("importFromSheet")}
            </Link>
          ) : null}
          {/* Every role: the header's Add stays the screen's one red primary action (DESIGN.md), so this one is quiet. */}
          <Button variant="quiet" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" strokeWidth={2} className="size-4" />
            {t("add")}
          </Button>
        </div>
      </StatePanel>
    );
  else
    body = (
      <LeadsTable
        rows={rows}
        total={total}
        hasNextPage={query.hasNextPage}
        isFetchingNextPage={query.isFetchingNextPage}
        fetchNextPage={() => void query.fetchNextPage()}
        activeId={activeId}
        onOpen={openLead}
        onPrefetch={prefetch}
        rowSelection={rowSelection}
        onRowSelectionChange={setRowSelection}
        columnVisibility={columnVisibility}
      />
    );

  return (
    <div className="flex flex-col gap-4 pt-4 lg:h-[calc(100dvh-72px-144px)] lg:min-h-[560px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-baseline gap-3 text-3xl font-bold sm:text-4xl">
          {t("title")}
          {total !== null ? (
            <span className="font-mono text-base font-normal text-muted-foreground">{format.number(total)}</span>
          ) : null}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          {/* Day 4c: the work queue. The default prefetch of a dynamic page stops at its loading skeleton: no data is read
              and nothing is claimed (claims start on Start), and the skeleton shows at once on a click. */}
          <Link href="/leads/queue" className={buttonVariants({ variant: "quiet" })}>
            <Headset aria-hidden="true" strokeWidth={1.75} className="size-4" />
            {t("workQueue")}
          </Link>
          {isAdmin ? (
            <Link href="/leads/import" className={buttonVariants({ variant: "quiet" })}>
              <Upload aria-hidden="true" strokeWidth={1.75} className="size-4" />
              {t("import")}
            </Link>
          ) : null}
          <Button onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" strokeWidth={2} className="size-4" />
            {t("add")}
          </Button>
        </div>
      </div>

      <div className={activeId ? "hidden lg:block" : undefined}>
      <LeadsToolbar
        filters={filters}
        onFiltersChange={setFilters}
        team={team}
        views={views}
        onViewsChange={setViews}
        hidden={hidden}
        onHiddenChange={setHiddenStore}
      />
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(340px,400px)]">
        <section
          aria-label={t("title")}
          className={cn("relative min-h-0 min-w-0 flex-col gap-3", activeId ? "hidden lg:flex" : "flex", "h-[calc(100dvh-72px-144px-180px)] min-h-[420px] lg:h-auto")}
        >
          {selectedRows.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
              <span className="px-1 font-bold">{t("selected", { count: selectedRows.length })}</span>
              <DropdownMenu>
                <DropdownMenuTrigger className="min-h-11 rounded-md px-3 underline-offset-4 hover:underline active:opacity-60 sm:min-h-9">{t("setStatus")}</DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {leadStatuses.map((s) => (
                    <DropdownMenuItem
                      key={s}
                      onSelect={() => {
                        setRowSelection({});
                        void changeStatus(before, s);
                      }}
                    >
                      {tStatus(s)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              {canAssign ? (
                <DropdownMenu>
                  <DropdownMenuTrigger className="min-h-11 rounded-md px-3 underline-offset-4 hover:underline active:opacity-60 sm:min-h-9">{t("setOwner")}</DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {team.map((m) => (
                      <DropdownMenuItem
                        key={m.id}
                        onSelect={() => {
                          setRowSelection({});
                          void changeOwner(before, m.id);
                        }}
                      >
                        {personName(m) || t("noName")}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuItem
                      onSelect={() => {
                        setRowSelection({});
                        void changeOwner(before, null);
                      }}
                    >
                      {t("unassigned")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              <button
                type="button"
                onClick={() => setRowSelection({})}
                className="ml-auto min-h-11 rounded-md px-3 underline-offset-4 transition-[scale] duration-150 hover:underline active:scale-[0.97] sm:min-h-9"
              >
                {t("clearSelection")}
              </button>
            </div>
          ) : null}
          {body}
        </section>

        <aside
          aria-label={activeId ? undefined : t("preview.empty")}
          className={cn(
            "relative min-h-0 overflow-y-auto overscroll-contain rounded-lg bg-card p-4 sm:p-6",
            activeId ? "block" : "hidden lg:block",
          )}
        >
          {activeId ? (
            // On phones the lead replaces the list: a short rise says "you went one level in" (desktop updates in place).
            <div key={activeId} className="max-lg:animate-page">
              <LeadPreview id={activeId} team={team} canAssign={canAssign} onClose={closeLead} onOpenPage={rememberList} />
            </div>
          ) : (
            <div className="grid h-full place-items-center text-center">
              <p className="max-w-[28ch] text-muted-foreground">{t("preview.empty")}</p>
            </div>
          )}
        </aside>
      </div>

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="max-h-[calc(100dvh-24vh)] overflow-y-auto p-6">
          <DialogTitle className="text-xl font-bold">{tForm("addTitle")}</DialogTitle>
          <DialogDescription className="mt-1 mb-4 text-sm text-muted-foreground">{tForm("addBody")}</DialogDescription>
          <LeadForm
            initial={emptyLead(me.id)}
            team={team}
            canAssign={canAssign}
            submitLabel={tForm("save")}
            onCancel={() => setAdding(false)}
            onSubmit={async (values) => {
              const res = await createLead(values);
              if (!res.ok) return res.error;
              setAdding(false);
              void queryClient.invalidateQueries({ queryKey: ["leads"] });
              navigate({ filters, lead: res.data.id }, activeId ? "replace" : "push");
              toast.show(tForm("added"));
              return null;
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatePanel({
  title,
  text,
  icon = false,
  role,
  children,
}: {
  title: string;
  text: string;
  icon?: boolean;
  role?: "alert";
  children?: React.ReactNode;
}) {
  return (
    <div role={role} className="flex flex-1 flex-col items-start gap-3 rounded-lg bg-card p-6 sm:p-8">
      {icon ? (
        <span className="grid size-11 place-items-center rounded-md bg-muted text-muted-foreground">
          <Users aria-hidden="true" strokeWidth={1.75} className="size-[22px]" />
        </span>
      ) : null}
      <h2 className="text-xl font-bold text-balance">{title}</h2>
      <p className="max-w-[60ch] text-muted-foreground">{text}</p>
      {children}
    </div>
  );
}

export function TableSkeleton() {
  return (
    <div aria-hidden="true" className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg bg-card">
      <div className="h-11 border-b border-border" />
      {Array.from({ length: 10 }, (_, i) => (
        <div key={i} className="flex h-14 items-center gap-4 border-b border-border px-4">
          <div className="size-4 rounded-sm bg-muted motion-safe:animate-pulse" />
          <div className="h-4 w-1/3 rounded-sm bg-muted motion-safe:animate-pulse" />
          <div className="hidden h-4 w-1/6 rounded-sm bg-muted motion-safe:animate-pulse md:block" />
          <div className="h-5 w-20 rounded-sm bg-muted motion-safe:animate-pulse" />
        </div>
      ))}
    </div>
  );
}

