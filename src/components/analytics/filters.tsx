"use client";

import { useId, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Combobox } from "@/components/ui/combobox";
import { DateRangePicker } from "@/components/ui/date-picker";
import { useAnalyticsFilters } from "@/components/analytics/analytics-context";
import { useViewWarmers } from "@/components/analytics/use-analytics";
import type { AnalyticsTeamMember } from "@/lib/analytics/fetch";
import type { AnalyticsRange } from "@/lib/analytics/params";
import { customRangeOk, filtersToSearch, teamOptions, type AnalyticsFilters } from "@/lib/analytics/view";
import { cn } from "@/lib/utils";

// The filter row (design 2, 4.1, 4.2): the range presets and a custom range, then the person picker for managers and
// admins ("Whole team" or one member). Every change goes to the URL (replaceState: no Back entries). Hovering or focusing
// a preset for 150 ms prefetches it once while fresh, so the click renders from the cache. On a phone the presets are a
// horizontal snap strip with "Custom…" at its end, and the person picker sits full width below.

type Preset = Exclude<AnalyticsRange, "custom">;
const PRESETS: Preset[] = ["7d", "30d", "90d", "mtd", "last_month"];

export function AnalyticsFiltersRow({ team }: { team: AnalyticsTeamMember[] | null }) {
  const t = useTranslations("Analytics.filters");
  const ta = useTranslations("Analytics");
  const locale = useLocale();
  const warm = useViewWarmers();
  const { filters, setFilters, today } = useAnalyticsFilters();
  const [tooLong, setTooLong] = useState(false);
  const hintId = useId();
  const personId = useId();
  const options = useMemo(
    () => (team ? [{ value: "", label: t("team") }, ...teamOptions(team, ta("noName"), locale)] : []),
    [team, t, ta, locale],
  );

  const withRange = (range: Preset): AnalyticsFilters => ({ range, rep: filters.rep, idle: filters.idle });
  const choose = (next: AnalyticsFilters) => {
    setTooLong(false);
    setFilters(next);
  };

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center lg:justify-between" role="group" aria-label={t("label")}>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="edge-fade -mx-4 flex snap-x items-center gap-2 overflow-x-auto overscroll-x-contain px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
          <div role="group" aria-label={t("presets")} className="inline-flex shrink-0 snap-start rounded-md bg-muted p-1">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={filters.range === p}
                onClick={() => choose(withRange(p))}
                {...warm(filtersToSearch(withRange(p)))}
                className={cn(
                  "min-h-11 shrink-0 rounded-sm px-3 text-sm font-bold whitespace-nowrap transition-[background-color,color,scale] duration-150 active:scale-[0.97] sm:min-h-9",
                  filters.range === p ? "bg-pill text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t(p)}
              </button>
            ))}
          </div>
          <DateRangePicker
            aria-label={t("customLabel")}
            aria-describedby={tooLong ? hintId : undefined}
            aria-invalid={tooLong || undefined}
            value={filters.range === "custom" && filters.from && filters.to ? { from: filters.from, to: filters.to } : { from: "", to: "" }}
            placeholder={t("custom")}
            max={today}
            onValueChange={({ from, to }) => {
              if (!from || !to) return;
              if (!customRangeOk(from, to, today)) {
                setTooLong(true);
                return;
              }
              choose({ range: "custom", from, to, rep: filters.rep, idle: filters.idle });
            }}
            className={cn(
              "w-auto shrink-0 snap-start text-sm font-bold sm:min-h-11",
              filters.range === "custom" ? "border-foreground" : "text-muted-foreground",
            )}
          />
        </div>
        <p id={hintId} role="status" className={cn("text-[13px] text-status-red", !tooLong && "sr-only")}>
          {tooLong ? t("tooLong") : null}
        </p>
      </div>
      {team ? (
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
          <label htmlFor={personId} className="text-sm text-muted-foreground">
            {t("person")}
          </label>
          <Combobox
            id={personId}
            value={filters.rep ?? ""}
            options={options}
            searchPlaceholder={t("personSearch")}
            emptyText={t("personEmpty")}
            onValueChange={(v) => choose({ ...filters, rep: v || undefined })}
            className="w-full sm:w-64"
          />
        </div>
      ) : null}
    </div>
  );
}
