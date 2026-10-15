"use client";

import { useEffect, useEffectEvent, useId, useMemo, useRef, useState } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Select } from "@/components/ui/select";
import { countriesByName } from "@/lib/countries";
import {
  TARGETS,
  assignTarget,
  autoMap,
  createOwnerMatcher,
  matchCountry,
  readDateParts,
  suggestDateOrder,
  suggestStatus,
  tally,
  type DateOrder,
  type NormaliseOptions,
  type NormalisedRecord,
  type Target,
} from "@/lib/import";
import type { ImportBatch } from "@/lib/import-server";
import { leadStatuses, personName, type LeadStatus, type TeamMember } from "@/lib/leads";
import { columnDateOrder, columnDateSample, columnValues } from "@/components/import/analysis";
import { readMapping, saveMapping } from "@/components/import/mapping-store";
import { TIME_ZONES, zoneLabel } from "@/components/import/zones";
import type { LoadedFile } from "@/components/import/read-file";
import { useModKey } from "@/lib/use-platform";
import { cn } from "@/lib/utils";

// Every choice made on this screen. The workspace keeps it, so coming back here (after a check that failed, or from
// the Check step) shows the same choices.
export type MatchState = {
  mapping: Target[];
  statusChoices: Map<string, LeadStatus>;
  defaultStatus: LeadStatus;
  ownerChoices: Map<string, string | null>;
  countryChoices: Map<string, string | null>;
  dateOrder: DateOrder | null;
  timeZone: string;
};

// Two sets of choices are the same when every part is the same value (state keeps each part's identity until it
// changes).
function sameChoices(a: NormaliseOptions, b: NormaliseOptions) {
  return (
    a.mapping === b.mapping &&
    a.team === b.team &&
    a.dateOrder === b.dateOrder &&
    a.timeZone === b.timeZone &&
    a.statusChoices === b.statusChoices &&
    a.defaultStatus === b.defaultStatus &&
    a.ownerChoices === b.ownerChoices &&
    a.countryChoices === b.countryChoices
  );
}

// Step 2: which column feeds which lead field, then the values that need a decision (owners who are not CRM users,
// status words we do not know, countries we do not recognise, the date order). Nothing is sent yet.
export function MatchStep({
  headingRef,
  file,
  team,
  defaultTimeZone,
  sameFileBefore,
  saved,
  onStateChange,
  onBack,
  onCheck,
  normalise,
}: {
  headingRef: React.Ref<HTMLHeadingElement>;
  file: LoadedFile;
  team: TeamMember[];
  defaultTimeZone: string;
  sameFileBefore: ImportBatch | null;
  saved: MatchState | null;
  onStateChange: (state: MatchState) => void;
  onBack: () => void;
  onCheck: (rows: NormalisedRecord[], timeZone: string) => void;
  normalise: (options: NormaliseOptions, signal: AbortSignal) => Promise<NormalisedRecord[]>;
}) {
  const t = useTranslations("Import.match");
  const ts = useTranslations("Leads.status");
  const format = useFormatter();
  const modKey = useModKey();
  const locale = useLocale();
  const { headers, records } = file.parsed;
  const suggested = useMemo(() => autoMap(headers), [headers]);
  // Choices already made for this file win; then a matching remembered for this exact header row; then the
  // suggestions. This step only ever renders in the browser (after a file is chosen), so storage can be read here.
  const [remembered] = useState(() => (saved ? null : readMapping(file.headerKey, headers.length)));
  const [mapping, setMapping] = useState<Target[]>(() => saved?.mapping ?? remembered ?? suggested.targets);
  const restored = remembered !== null;
  const [statusChoices, setStatusChoices] = useState<Map<string, LeadStatus>>(() => saved?.statusChoices ?? new Map());
  const [defaultStatus, setDefaultStatus] = useState<LeadStatus>(() => saved?.defaultStatus ?? "cold");
  const [ownerChoices, setOwnerChoices] = useState<Map<string, string | null>>(() => saved?.ownerChoices ?? new Map());
  const [countryChoices, setCountryChoices] = useState<Map<string, string | null>>(() => saved?.countryChoices ?? new Map());
  const [timeZone, setTimeZone] = useState(() => saved?.timeZone ?? defaultTimeZone);
  const [dateOrder, setDateOrder] = useState<DateOrder | null>(() => saved?.dateOrder ?? null);
  const [preparing, setPreparing] = useState(false);
  const preparingRun = useRef<AbortController | null>(null);

  useEffect(() => {
    onStateChange({ mapping, statusChoices, defaultStatus, ownerChoices, countryChoices, dateOrder, timeZone });
  }, [mapping, statusChoices, defaultStatus, ownerChoices, countryChoices, dateOrder, timeZone, onStateChange]);

  // Leaving the step (Choose another file, Past imports, another page) stops the cleaning: it never starts a check.
  useEffect(() => () => preparingRun.current?.abort(), []);

  const statusCol = mapping.indexOf("status");
  const ownerCol = mapping.indexOf("owner");
  const countryCol = mapping.indexOf("country");
  const dateCol = mapping.indexOf("last_activity");
  // Usually prepared while the file was read (analysis.ts); a column matched by hand is worked out here.
  const statuses = columnValues(records, statusCol, "status");
  const owners = columnValues(records, ownerCol, "owner");
  const countries = columnValues(records, countryCol, "country");
  const dateGuess = columnDateOrder(records, dateCol);
  // The full country list only when a value needs a choice (it is long to build, then remembered).
  const countryOptions = countries.some((c) => !matchCountry(c.label)) ? countriesByName(locale) : [];
  const order: DateOrder = dateOrder ?? (dateGuess ? suggestDateOrder(dateGuess) : "dmy");
  const sample = columnDateSample(records, dateCol);
  // Names prepared while the file was read (zones.ts).
  const zoneOptions = [...new Set([defaultTimeZone, ...TIME_ZONES])].map((zone) => ({ zone, label: zoneLabel(zone, locale) }));

  // "So 01/09/2023 is 1 September 2023.": a date from the file, read in the chosen order (shown under the choice, so
  // the menu itself stays short), or why it does not read that way. French writes the first of a month "1er".
  const dateHintId = useId();
  const readsAs = (() => {
    if (!sample) return "";
    const parts = readDateParts(sample, order);
    if (!parts) return t("dateNotInOrder", { raw: sample });
    const [year, month, day] = parts;
    const date = new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" })
      .formatToParts(new Date(Date.UTC(year, month - 1, day)))
      .map((part) => (part.type === "day" && day === 1 ? t("dayOne") : part.value))
      .join("");
    return t("dateReadsAs", { raw: sample, date });
  })();

  const matchOwner = useMemo(() => createOwnerMatcher(team), [team]);
  const unknownStatuses = statuses.filter((s) => !suggestStatus(s.label) && !statusChoices.has(s.key));
  const unknownCountries = countries.filter((c) => !matchCountry(c.label));
  const nameMissing = !mapping.includes("name");
  const blocked = nameMissing ? t("needName") : unknownStatuses.length > 0 ? t("needStatus", { count: unknownStatuses.length }) : null;
  const ownersMatched = owners.filter((o) => matchOwner(o.label)).length;

  // Everything the cleaning depends on.
  const options: NormaliseOptions = { mapping, team, dateOrder: order, timeZone, statusChoices, defaultStatus, ownerChoices, countryChoices };
  // The latest choices, for a check that is already preparing (a change made meanwhile is used, not lost).
  const latest = useRef({ options, blocked });
  useEffect(() => {
    latest.current = { options, blocked };
  });

  // Live counts ("Ready to check · Need fixing"): every row is cleaned again, in slices, a moment after the last
  // change; a newer change stops the run before it. Check file uses these rows when the choices have not changed since.
  const [preview, setPreview] = useState<{ options: NormaliseOptions; rows: NormalisedRecord[]; ready: number; fix: number } | null>(null);
  useEffect(() => {
    if (blocked) return;
    const choices: NormaliseOptions = { mapping, team, dateOrder: order, timeZone, statusChoices, defaultStatus, ownerChoices, countryChoices };
    const run = new AbortController();
    const timer = setTimeout(() => {
      normalise(choices, run.signal)
        .then((rows) => {
          if (run.signal.aborted) return;
          const counts = tally(rows);
          setPreview({ options: choices, rows, ready: counts.staged, fix: counts.rejected });
        })
        .catch(() => {
          // Stopped by a newer change, or the step was left: nothing to show.
        });
    }, 400);
    return () => {
      clearTimeout(timer);
      run.abort();
    };
  }, [blocked, normalise, mapping, team, order, timeZone, statusChoices, defaultStatus, ownerChoices, countryChoices]);
  const counted = preview && sameChoices(preview.options, options) ? preview : null;
  // One status line, always in the page so screen readers hear each settled change: what blocks the check, else the
  // counts. While a change is counted the last counts stay (no flicker); "Counting the rows…" shows only at first.
  const countsId = useId();
  const recounting = !blocked && preview !== null && counted === null;
  const shown = counted ?? preview;
  const statusLine =
    blocked ??
    (shown
      ? t("previewCounts", {
          ready: shown.ready,
          readyFormatted: format.number(shown.ready),
          fix: shown.fix,
          fixFormatted: format.number(shown.fix),
        })
      : t("previewCounting"));

  // Up to three example values per column, read once per file (stops as soon as every column has three).
  const examples = useMemo(() => {
    const found: string[][] = headers.map(() => []);
    let missing = headers.length;
    for (const record of records) {
      if (missing === 0) break;
      found.forEach((values, column) => {
        if (values.length === 3) return;
        const value = record.cells[column]?.trim();
        if (!value) return;
        values.push(value);
        if (values.length === 3) missing--;
      });
    }
    return found;
  }, [headers, records]);

  const check = async () => {
    if (blocked || preparingRun.current) return;
    const run = new AbortController();
    preparingRun.current = run;
    setPreparing(true);
    try {
      // The rows of the live counts when they match these choices; else every row is cleaned now, in slices, letting
      // the page answer in between (tens of thousands of rows take a moment).
      let wanted = options;
      let rows = counted ? counted.rows : await normalise(wanted, run.signal);
      // A choice changed while the rows were being cleaned: clean them again with it (or stop, if it now needs one).
      while (!run.signal.aborted && !sameChoices(latest.current.options, wanted)) {
        if (latest.current.blocked) {
          setPreparing(false);
          return;
        }
        wanted = latest.current.options;
        rows = await normalise(wanted, run.signal);
      }
      if (run.signal.aborted) return;
      saveMapping(file.headerKey, wanted.mapping);
      setPreparing(false);
      onCheck(rows, wanted.timeZone);
    } catch {
      if (!run.signal.aborted) setPreparing(false);
    } finally {
      preparingRun.current = null;
    }
  };

  // Cmd/Ctrl+Enter: the step's main action.
  const onShortcut = useEffectEvent(() => void check());
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !document.querySelector("[role=dialog]")) {
        event.preventDefault();
        onShortcut();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h2 ref={headingRef} id="import-step-heading" tabIndex={-1} className="text-xl font-bold tracking-[-0.03em] text-balance focus:outline-none">
          {t("title")}
        </h2>
        <p className="max-w-[65ch] text-muted-foreground wrap-anywhere">
          {t("fileLine", {
            file: file.name,
            rows: file.parsed.rowCount,
            rowsFormatted: format.number(file.parsed.rowCount),
            columns: headers.length,
            columnsFormatted: format.number(headers.length),
            separator: file.parsed.delimiter === "\t" ? t("tab") : file.parsed.delimiter,
          })}
        </p>
        {file.encoding === "windows-1252" ? <Notice tone="amber">{t("encodingNotice")}</Notice> : null}
        {sameFileBefore ? (
          <Notice tone="amber">
            {t("sameFile", {
              date: format.dateTime(new Date(sameFileBefore.imported_at ?? sameFileBefore.created_at), { dateStyle: "medium" }),
              count: sameFileBefore.imported,
              formatted: format.number(sameFileBefore.imported),
            })}
          </Notice>
        ) : null}
        {restored ? <p className="max-w-[65ch] text-sm text-muted-foreground">{t("restored")}</p> : null}
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="font-bold">{t("columnsTitle")}</h3>
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {headers.map((header, i) => (
            <ColumnRow
              key={`${i}-${header}`}
              header={header || t("noHeader", { n: i + 1 })}
              examples={examples[i]}
              value={mapping[i]}
              matched={suggested.matched[i] && suggested.targets[i] === mapping[i] && mapping[i] !== "ignore"}
              onChange={(target) => setMapping((m) => assignTarget(m, i, target))}
            />
          ))}
        </ul>
        {nameMissing ? <Notice tone="red">{t("needName")}</Notice> : null}
      </div>

      {statuses.length > 0 ? (
        <ValueSection title={t("statusTitle")} hint={t("statusHint")}>
          {statuses.map((s) => {
            const suggestion = suggestStatus(s.label);
            const value = statusChoices.get(s.key) ?? suggestion ?? "";
            return (
              <ValueRow key={s.key} label={s.label} count={s.count} needsChoice={!value}>
                <Select
                  aria-label={t("statusFor", { value: s.label })}
                  value={value}
                  onChange={(e) => setStatusChoices((m) => new Map(m).set(s.key, e.target.value as LeadStatus))}
                  aria-invalid={!value || undefined}
                >
                  {!value ? <option value="">{t("choose")}</option> : null}
                  {leadStatuses.map((code) => (
                    <option key={code} value={code}>
                      {ts(code)}
                    </option>
                  ))}
                </Select>
              </ValueRow>
            );
          })}
          <ValueRow label={t("blankStatus")} count={null}>
            <Select aria-label={t("blankStatus")} value={defaultStatus} onChange={(e) => setDefaultStatus(e.target.value as LeadStatus)}>
              {leadStatuses.map((code) => (
                <option key={code} value={code}>
                  {ts(code)}
                </option>
              ))}
            </Select>
          </ValueRow>
        </ValueSection>
      ) : null}

      {owners.length > 0 ? (
        <ValueSection
          title={t("ownerTitle")}
          hint={t("ownerHint", {
            matched: ownersMatched,
            matchedFormatted: format.number(ownersMatched),
            total: owners.length,
            totalFormatted: format.number(owners.length),
          })}
        >
          {owners.map((o) => {
            const suggestion = matchOwner(o.label);
            const value = ownerChoices.has(o.key) ? ownerChoices.get(o.key) ?? "" : suggestion ?? "";
            return (
              <ValueRow key={o.key} label={o.label} count={o.count} amber={!value}>
                <Select
                  aria-label={t("ownerFor", { value: o.label })}
                  value={value}
                  onChange={(e) => setOwnerChoices((m) => new Map(m).set(o.key, e.target.value || null))}
                >
                  <option value="">{t("unassigned")}</option>
                  {team.map((m) => (
                    <option key={m.id} value={m.id}>
                      {personName(m) || t("noName")}
                    </option>
                  ))}
                </Select>
              </ValueRow>
            );
          })}
        </ValueSection>
      ) : null}

      {unknownCountries.length > 0 ? (
        <ValueSection title={t("countryTitle")} hint={t("countryHint")}>
          {unknownCountries.slice(0, 200).map((c) => (
            <ValueRow key={c.key} label={c.label} count={c.count} amber={!countryChoices.get(c.key)}>
              <Select
                aria-label={t("countryFor", { value: c.label })}
                value={countryChoices.get(c.key) ?? ""}
                onChange={(e) => setCountryChoices((m) => new Map(m).set(c.key, e.target.value || null))}
              >
                <option value="">{t("leaveBlank")}</option>
                {countryOptions.map((country) => (
                  <option key={country.code} value={country.code}>
                    {country.name}
                  </option>
                ))}
              </Select>
            </ValueRow>
          ))}
          {unknownCountries.length > 200 ? <Notice tone="amber">{t("tooManyValues")}</Notice> : null}
        </ValueSection>
      ) : null}

      {dateGuess ? (
        <ValueSection title={t("dateTitle")} hint={dateGuess.order === "mixed" ? t("dateMixed") : t("dateHint")}>
          <ValueRow label={t("dateOrder")} count={null} hint={readsAs} hintId={sample ? dateHintId : undefined}>
            <Select
              aria-label={t("dateOrder")}
              aria-describedby={sample ? dateHintId : undefined}
              value={order}
              onChange={(e) => setDateOrder(e.target.value as DateOrder)}
            >
              <option value="dmy">{t("dmy")}</option>
              <option value="mdy">{t("mdy")}</option>
            </Select>
          </ValueRow>
          <ValueRow label={t("timeZone")} count={null}>
            <Select aria-label={t("timeZone")} value={timeZone} onChange={(e) => setTimeZone(e.target.value)}>
              {zoneOptions.map(({ zone, label }) => (
                <option key={zone} value={zone}>
                  {label}
                </option>
              ))}
            </Select>
          </ValueRow>
        </ValueSection>
      ) : null}

      <div className="import-action-bar sticky bottom-24 z-10 -mx-4 flex flex-col gap-3 border-t border-border bg-card px-4 pt-4 pb-2 sm:static sm:mx-0 sm:flex-row sm:items-center sm:justify-between sm:border-0 sm:p-0">
        <Button variant="link" onClick={onBack}>
          {t("back")}
        </Button>
        <div className="flex flex-col gap-2 sm:items-end">
          {/* While the rows are prepared the button stays focusable (aria-disabled): a disabled button would drop the
              keyboard focus to the page. */}
          <Button
            variant="neutral"
            onClick={() => void check()}
            disabled={Boolean(blocked)}
            aria-disabled={preparing || undefined}
            aria-describedby={countsId}
            className={cn(preparing && "opacity-60")}
          >
            {preparing ? t("preparing") : t("check")}
            {modKey ? <Kbd className="max-sm:hidden">{`${modKey} ↩`}</Kbd> : null}
          </Button>
          <p id={countsId} role="status" aria-atomic="true" aria-busy={recounting || undefined} className="text-sm text-muted-foreground">
            {statusLine}
          </p>
        </div>
      </div>
    </div>
  );
}

function ColumnRow({
  header,
  examples,
  value,
  matched,
  onChange,
}: {
  header: string;
  examples: string[];
  value: Target;
  matched: boolean;
  onChange: (target: Target) => void;
}) {
  const t = useTranslations("Import.match");
  const id = useId();
  return (
    // Three columns (header, examples, menu) only where the header has room (xl); narrower, the examples sit under
    // the header. The header wraps rather than being cut.
    <li className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_248px] sm:items-center xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_248px]">
      <div className="flex min-w-0 flex-col gap-1 xl:contents">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <label htmlFor={id} className="min-w-0 font-bold wrap-anywhere">
            {header}
          </label>
          {matched ? (
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-sm bg-muted px-2 py-0.5 text-xs">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-status-green" />
              {t("matched")}
            </span>
          ) : null}
        </div>
        <p className="min-w-0 text-sm text-muted-foreground wrap-anywhere">
          {examples.length ? examples.join(" · ") : t("emptyColumn")}
        </p>
      </div>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value as Target)}>
        {TARGETS.map((target) => (
          <option key={target} value={target}>
            {t(`targets.${target}`)}
          </option>
        ))}
      </Select>
    </li>
  );
}

function ValueSection({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="font-bold">{title}</h3>
        <p className="max-w-[65ch] text-sm text-muted-foreground">{hint}</p>
      </div>
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">{children}</ul>
    </section>
  );
}

function ValueRow({
  label,
  count,
  needsChoice = false,
  amber = false,
  hint,
  hintId,
  children,
}: {
  label: string;
  count: number | null;
  needsChoice?: boolean;
  amber?: boolean;
  /** A line under the choice that says what it means; with `hintId` it stays in the page and is announced when it changes. */
  hint?: string;
  hintId?: string;
  children: React.ReactNode;
}) {
  const t = useTranslations("Import.match");
  const format = useFormatter();
  return (
    <li className="grid grid-cols-1 gap-2 p-4 sm:grid-cols-[minmax(0,1fr)_248px] sm:items-center">
      <div className="flex min-w-0 items-center gap-2">
        {needsChoice || amber ? (
          <span aria-hidden="true" className={needsChoice ? "size-1.5 shrink-0 rounded-full bg-status-red" : "size-1.5 shrink-0 rounded-full bg-status-amber"} />
        ) : null}
        <span className="min-w-0 wrap-anywhere">
          {label}
        </span>
        {count !== null ? (
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{t("rowsCount", { count, formatted: format.number(count) })}</span>
        ) : null}
        {needsChoice ? <span className="sr-only">{t("needsChoice")}</span> : null}
      </div>
      {children}
      {hintId ? (
        <p id={hintId} className="max-w-[65ch] text-sm text-muted-foreground sm:col-span-2" aria-live="polite">
          {hint}
        </p>
      ) : null}
    </li>
  );
}

function Notice({ tone, children }: { tone: "amber" | "red"; children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-sm">
      <span aria-hidden="true" className={tone === "amber" ? "mt-1.5 size-1.5 shrink-0 rounded-full bg-status-amber" : "mt-1.5 size-1.5 shrink-0 rounded-full bg-status-red"} />
      <span className="min-w-0 wrap-anywhere">{children}</span>
    </p>
  );
}
