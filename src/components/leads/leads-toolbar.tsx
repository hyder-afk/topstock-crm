"use client";

import { useEffect, useEffectEvent, useId, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Bookmark, ChevronDown, Columns3, ListFilter, Trash2, X } from "lucide-react";
import { deleteView, saveView } from "@/app/(app)/leads/actions";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchInput } from "@/components/ui/search-input";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/components/ui/toast";
import { countriesByName, countryName } from "@/lib/countries";
import {
  activeFilterCount,
  filtersToParams,
  inactivityOptions,
  leadSorts,
  leadStatuses,
  optionalColumns,
  personName,
  type LeadFilters,
  type LeadSort,
  type OptionalColumn,
  type TeamMember,
} from "@/lib/leads";
import type { SavedView } from "@/lib/leads-server";
import { cn } from "@/lib/utils";

const control = cn(buttonVariants({ variant: "quiet" }), "min-h-11 gap-2 px-3 text-sm font-normal sm:min-h-10");

// Calls onSettle once the value has stopped changing for ms. Only the value restarts the timer (useEffectEvent
// always sees the latest onSettle without being a dependency).
function useDebounced<T>(value: T, ms: number, onSettle: (v: T) => void) {
  const settle = useEffectEvent(onSettle);
  useEffect(() => {
    const timer = window.setTimeout(() => settle(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
}

export function LeadsToolbar({
  filters,
  onFiltersChange,
  team,
  views,
  onViewsChange,
  hidden,
  onHiddenChange,
}: {
  filters: LeadFilters;
  onFiltersChange: (next: LeadFilters) => void;
  team: TeamMember[];
  views: SavedView[];
  onViewsChange: (next: SavedView[]) => void;
  hidden: OptionalColumn[];
  onHiddenChange: (next: OptionalColumn[]) => void;
}) {
  const t = useTranslations("Leads");
  const tCol = useTranslations("Leads.col");
  const tSort = useTranslations("Leads.sorts");
  const [search, setSearch] = useState(filters.q ?? "");
  const searchId = useId();

  // The search box follows the URL (Back, saved views) and writes to it 250 ms after typing stops.
  const [lastQ, setLastQ] = useState(filters.q ?? "");
  if ((filters.q ?? "") !== lastQ) {
    setLastQ(filters.q ?? "");
    setSearch(filters.q ?? "");
  }
  useDebounced(search, 250, (v) => {
    const q = v.trim() || undefined;
    if (q !== (filters.q || undefined)) onFiltersChange({ ...filters, q });
  });

  const count = activeFilterCount(filters);
  const sort: LeadSort = filters.sort ?? "activity";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-[1_1_280px]">
          <label htmlFor={searchId} className="sr-only">
            {t("searchLabel")}
          </label>
          <SearchInput
            id={searchId}
            name="q"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("searchPlaceholder")}
            maxLength={100}
            className="text-sm sm:min-h-10"
          />
        </div>

        <Popover>
          <PopoverTrigger className={cn(control, count > 0 && "bg-primary text-primary-foreground hover:brightness-110 dark:hover:brightness-110")}>
            <ListFilter aria-hidden="true" strokeWidth={1.75} className="size-4" />
            {count > 0 ? (
              <>
                <span aria-hidden="true">{t("filters")}</span>
                <span aria-hidden="true" className="font-mono">
                  {count}
                </span>
                <span className="sr-only">{t("filtersCount", { count })}</span>
              </>
            ) : (
              t("filters")
            )}
          </PopoverTrigger>
          <PopoverContent className="w-[min(400px,calc(100vw-32px))] p-0">
            <FilterPanel filters={filters} onChange={onFiltersChange} team={team} />
          </PopoverContent>
        </Popover>

        <ViewsPopover filters={filters} views={views} onViewsChange={onViewsChange} onApply={onFiltersChange} />

        <DropdownMenu>
          <DropdownMenuTrigger className={control}>
            <Columns3 aria-hidden="true" strokeWidth={1.75} className="size-4" />
            <span className="hidden sm:inline">{t("columns")}</span>
            <span className="sr-only sm:hidden">{t("columns")}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>{t("columns")}</DropdownMenuLabel>
            {optionalColumns.map((c) => (
              <DropdownMenuCheckboxItem
                key={c}
                checked={!hidden.includes(c)}
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={(on) => onHiddenChange(on ? hidden.filter((h) => h !== c) : [...hidden, c])}
              >
                {tCol(c)}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger className={control}>
            <span className="hidden sm:inline">{t("sortBy", { sort: tSort(sort) })}</span>
            <span className="sm:hidden">{t("sort")}</span>
            <ChevronDown aria-hidden="true" strokeWidth={1.75} className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuRadioGroup value={sort} onValueChange={(v) => onFiltersChange({ ...filters, sort: v as LeadSort })}>
              {leadSorts.map((s) => (
                <DropdownMenuRadioItem key={s} value={s}>
                  {tSort(s)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <FilterChips filters={filters} onChange={onFiltersChange} team={team} />
    </div>
  );
}

function CheckRow({ label, checked, onChange, lang }: { label: string; checked: boolean; onChange: (on: boolean) => void; lang?: string }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 text-sm hover:bg-muted sm:min-h-9">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-foreground" />
      <span className="min-w-0 truncate" lang={lang}>
        {label}
      </span>
    </label>
  );
}

function toggle<T>(list: T[] | undefined, item: T, on: boolean): T[] | undefined {
  const next = on ? [...(list ?? []), item] : (list ?? []).filter((x) => x !== item);
  return next.length ? next : undefined;
}

function FilterPanel({ filters, onChange, team }: { filters: LeadFilters; onChange: (f: LeadFilters) => void; team: TeamMember[] }) {
  const t = useTranslations("Leads");
  const tF = useTranslations("Leads.filter");
  const tStatus = useTranslations("Leads.status");
  const locale = useLocale();
  const countries = useMemo(() => countriesByName(locale), [locale]);
  const [countryQuery, setCountryQuery] = useState("");
  const [city, setCity] = useState(filters.city ?? "");
  const id = useId();

  useDebounced(city, 300, (v) => {
    const next = v.trim() || undefined;
    if (next !== (filters.city || undefined)) onChange({ ...filters, city: next });
  });

  const selectedCountries = filters.country ?? [];
  const q = countryQuery.trim().toLocaleLowerCase(locale);
  const countryList = [
    ...countries.filter((c) => selectedCountries.includes(c.code)),
    ...countries.filter((c) => !selectedCountries.includes(c.code) && q && c.name.toLocaleLowerCase(locale).includes(q)).slice(0, 8),
  ];

  return (
    <div className="flex max-h-[min(70vh,560px)] flex-col">
      <div className="flex flex-col gap-5 overflow-y-auto p-4">
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-xs font-bold text-muted-foreground">{tF("status")}</legend>
          {leadStatuses.map((s) => (
            <CheckRow
              key={s}
              label={tStatus(s)}
              checked={filters.status?.includes(s) ?? false}
              onChange={(on) => onChange({ ...filters, status: toggle(filters.status, s, on) })}
            />
          ))}
        </fieldset>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-xs font-bold text-muted-foreground">{tF("owner")}</legend>
          {team.map((m) => (
            <CheckRow
              key={m.id}
              label={personName(m) || t("noName")}
              checked={filters.owner?.includes(m.id) ?? false}
              onChange={(on) => onChange({ ...filters, owner: toggle(filters.owner, m.id, on) })}
            />
          ))}
          <CheckRow
            label={tF("unassigned")}
            checked={filters.owner?.includes("none") ?? false}
            onChange={(on) => onChange({ ...filters, owner: toggle(filters.owner, "none", on) })}
          />
        </fieldset>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-xs font-bold text-muted-foreground">{tF("country")}</legend>
          <SearchInput
            name="country-search"
            label={tF("countrySearch")}
            placeholder={tF("countrySearch")}
            value={countryQuery}
            onChange={(e) => setCountryQuery(e.target.value)}
            className="text-sm sm:min-h-10"
          />
          {countryList.length ? (
            <div className="flex flex-col gap-1">
              {countryList.map((c) => (
                <CheckRow
                  key={c.code}
                  label={c.name}
                  checked={selectedCountries.includes(c.code)}
                  onChange={(on) => onChange({ ...filters, country: toggle(filters.country, c.code, on) })}
                />
              ))}
            </div>
          ) : null}
        </fieldset>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-city`} className="text-xs text-muted-foreground">
            {tF("city")}
          </Label>
          <Input
            id={`${id}-city`}
            name="city"
            value={city}
            onChange={(e) => setCity(e.target.value)}
            placeholder={tF("cityPlaceholder")}
            maxLength={120}
            autoComplete="off"
            className="text-sm sm:min-h-10"
          />
        </div>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-xs font-bold text-muted-foreground">{tF("inactivity")}</legend>
          {[undefined, ...inactivityOptions].map((d) => (
            <label key={d ?? "any"} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 text-sm hover:bg-muted sm:min-h-9">
              <input
                type="radio"
                name={`${id}-inactive`}
                checked={filters.inactive === d}
                onChange={() => onChange({ ...filters, inactive: d })}
                className="size-4 accent-foreground"
              />
              {d ? tF("inactiveDays", { days: d }) : tF("any")}
            </label>
          ))}
        </fieldset>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border p-3">
        <Button
          variant="link"
          onClick={() => {
            setCity("");
            onChange({ q: filters.q, sort: filters.sort });
          }}
        >
          {t("clearFilters")}
        </Button>
        <PopoverClose className={buttonVariants({ variant: "neutral" })}>{t("done")}</PopoverClose>
      </div>
    </div>
  );
}

function FilterChips({ filters, onChange, team }: { filters: LeadFilters; onChange: (f: LeadFilters) => void; team: TeamMember[] }) {
  const t = useTranslations("Leads");
  const tF = useTranslations("Leads.filter");
  const tStatus = useTranslations("Leads.status");
  const locale = useLocale();
  const chips: { key: string; label: string; remove: () => void }[] = [];
  filters.status?.forEach((s) =>
    chips.push({ key: `s-${s}`, label: tF("chipStatus", { value: tStatus(s) }), remove: () => onChange({ ...filters, status: toggle(filters.status, s, false) }) }),
  );
  filters.owner?.forEach((o) => {
    const name = o === "none" ? tF("unassigned") : personName(team.find((m) => m.id === o)) || t("noName");
    chips.push({ key: `o-${o}`, label: tF("chipOwner", { value: name }), remove: () => onChange({ ...filters, owner: toggle(filters.owner, o, false) }) });
  });
  filters.country?.forEach((c) =>
    chips.push({
      key: `c-${c}`,
      label: tF("chipCountry", { value: countryName(c, locale) }),
      remove: () => onChange({ ...filters, country: toggle(filters.country, c, false) }),
    }),
  );
  if (filters.city) chips.push({ key: "city", label: tF("chipCity", { value: filters.city }), remove: () => onChange({ ...filters, city: undefined }) });
  if (filters.inactive)
    chips.push({ key: "inactive", label: tF("chipInactive", { days: filters.inactive }), remove: () => onChange({ ...filters, inactive: undefined }) });
  if (filters.batch) chips.push({ key: "batch", label: tF("chipBatch"), remove: () => onChange({ ...filters, batch: undefined }) });
  if (!chips.length) return null;
  return (
    <ul className="flex flex-wrap items-center gap-2">
      {chips.map((c) => (
        <li key={c.key}>
          <span className="inline-flex min-h-8 items-center gap-1 rounded-sm bg-muted py-0.5 pr-1 pl-3 text-xs">
            {c.label}
            <button
              type="button"
              onClick={c.remove}
              aria-label={tF("remove", { name: c.label })}
              className="grid size-7 place-items-center rounded-sm text-muted-foreground hover:text-foreground active:scale-[0.97]"
            >
              <X aria-hidden="true" strokeWidth={1.75} className="size-3.5" />
            </button>
          </span>
        </li>
      ))}
      <li>
        <Button variant="link" className="min-h-8 text-xs" onClick={() => onChange({ q: filters.q, sort: filters.sort })}>
          {t("clearFilters")}
        </Button>
      </li>
    </ul>
  );
}

function ViewsPopover({
  filters,
  views,
  onViewsChange,
  onApply,
}: {
  filters: LeadFilters;
  views: SavedView[];
  onViewsChange: (next: SavedView[]) => void;
  onApply: (f: LeadFilters) => void;
}) {
  const t = useTranslations("Leads");
  const tErr = useTranslations("Leads.errors");
  const toast = useToast();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const id = useId();

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setPending(true);
    const asParams = Object.fromEntries(filtersToParams(filters));
    const res = await saveView({ name, filters: asParams });
    setPending(false);
    if (!res.ok) {
      toast.show(tErr(res.error));
      return;
    }
    onViewsChange(
      [...views, { id: res.data.id, name: name.trim(), filters, created_at: new Date().toISOString() }].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    );
    setName("");
    toast.show(t("viewSaved"));
  }

  async function remove(view: SavedView) {
    const res = await deleteView(view.id);
    if (!res.ok) {
      toast.show(tErr(res.error));
      return;
    }
    const remaining = views.filter((v) => v.id !== view.id);
    onViewsChange(remaining);
    // Deleting is undoable: Undo saves the same name and filters again.
    toast.show(t("viewDeleted"), {
      label: t("undo"),
      run: async () => {
        const again = await saveView({ name: view.name, filters: Object.fromEntries(filtersToParams(view.filters)) });
        if (!again.ok) return toast.show(tErr(again.error));
        onViewsChange([...remaining, { ...view, id: again.data.id }].sort((a, b) => a.name.localeCompare(b.name)));
        toast.show(t("undone"));
      },
    });
  }

  return (
    <Popover>
      <PopoverTrigger className={control}>
        <Bookmark aria-hidden="true" strokeWidth={1.75} className="size-4" />
        <span className="hidden sm:inline">{t("views")}</span>
        <span className="sr-only sm:hidden">{t("views")}</span>
      </PopoverTrigger>
      <PopoverContent className="flex flex-col gap-3">
        <h2 className="text-sm font-bold">{t("viewsTitle")}</h2>
        {views.length ? (
          <ul className="flex flex-col gap-1">
            {views.map((v) => (
              <li key={v.id} className="flex items-center gap-1">
                <PopoverClose
                  onClick={() => onApply({ ...v.filters })}
                  className="flex min-h-11 min-w-0 flex-1 items-center rounded-md px-2 text-left text-sm hover:bg-muted sm:min-h-9"
                >
                  <span className="truncate">{v.name}</span>
                </PopoverClose>
                <button
                  type="button"
                  onClick={() => void remove(v)}
                  aria-label={t("deleteView", { name: v.name })}
                  className="grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground hover:text-foreground active:scale-[0.97] sm:size-9"
                >
                  <Trash2 aria-hidden="true" strokeWidth={1.75} className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("viewsEmpty")}</p>
        )}
        <form noValidate onSubmit={save} className="flex flex-col gap-2 border-t border-border pt-3">
          <Label htmlFor={`${id}-name`} className="text-xs text-muted-foreground">
            {t("viewName")}
          </Label>
          <div className="flex gap-2">
            <Input id={`${id}-name`} name="view-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" className="text-sm sm:min-h-10" />
            <Button type="submit" variant="neutral" disabled={pending || !name.trim()} className="shrink-0 sm:min-h-10">
              {t("saveView")}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
