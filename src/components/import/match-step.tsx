"use client";

import { useEffect, useEffectEvent, useId, useMemo, useState } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Select } from "@/components/ui/select";
import { countriesByName } from "@/lib/countries";
import {
  TARGETS,
  assignTarget,
  autoMap,
  countryKey,
  createOwnerMatcher,
  detectDateOrder,
  distinctValues,
  headerFingerprint,
  matchCountry,
  ownerKey,
  statusKey,
  suggestDateOrder,
  suggestStatus,
  type DateOrder,
  type NormaliseOptions,
  type NormalisedRecord,
  type Target,
} from "@/lib/import";
import type { ImportBatch } from "@/lib/import-server";
import { leadStatuses, personName, type LeadStatus, type TeamMember } from "@/lib/leads";
import type { LoadedFile } from "@/components/import/choose-step";
import { useModKey } from "@/lib/use-platform";

export type MatchChoices = { timeZone: string };

const mappingKey = (fingerprint: string) => `topstock.import.mapping.${fingerprint}`;

// A remembered column matching for the same header row (a per-person convenience in this browser; never lead data).
function readMapping(fingerprint: string, length: number): Target[] | null {
  try {
    const raw = window.localStorage.getItem(mappingKey(fingerprint));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed) && parsed.length === length && parsed.every((x) => (TARGETS as readonly string[]).includes(x))) {
      return parsed as Target[];
    }
  } catch {
    // Storage blocked: start from the suggestions.
  }
  return null;
}

function saveMapping(fingerprint: string, mapping: readonly Target[]) {
  try {
    window.localStorage.setItem(mappingKey(fingerprint), JSON.stringify(mapping));
  } catch {
    // Storage blocked: nothing to remember.
  }
}

const timeZones = ["Europe/Paris", "Europe/London", "Europe/Brussels", "Europe/Berlin", "Europe/Madrid", "Africa/Casablanca", "America/New_York", "UTC"];

// Step 2: which column feeds which lead field, then the values that need a decision (owners who are not CRM users,
// status words we do not know, countries we do not recognise, the date order). Nothing is sent yet.
export function MatchStep({
  headingRef,
  file,
  team,
  defaultTimeZone,
  sameFileBefore,
  onChange,
  onBack,
  onCheck,
  normalise,
}: {
  headingRef: React.Ref<HTMLHeadingElement>;
  file: LoadedFile;
  team: TeamMember[];
  defaultTimeZone: string;
  sameFileBefore: ImportBatch | null;
  onChange: (choices: MatchChoices) => void;
  onBack: () => void;
  onCheck: (rows: NormalisedRecord[]) => void;
  normalise: (options: NormaliseOptions) => Promise<NormalisedRecord[]>;
}) {
  const t = useTranslations("Import.match");
  const ts = useTranslations("Leads.status");
  const format = useFormatter();
  const modKey = useModKey();
  const locale = useLocale();
  const { headers, records } = file.parsed;
  const fingerprint = useMemo(() => headerFingerprint(file.parsed.rawHeaders), [file.parsed.rawHeaders]);
  const suggested = useMemo(() => autoMap(headers), [headers]);
  // A matching remembered for this exact header row wins over the suggestions. This step only ever renders in the
  // browser (after a file is chosen), so storage can be read on the first render.
  const [remembered] = useState(() => readMapping(fingerprint, headers.length));
  const [mapping, setMapping] = useState<Target[]>(() => remembered ?? suggested.targets);
  const restored = remembered !== null;
  const [statusChoices, setStatusChoices] = useState<Map<string, LeadStatus>>(() => new Map());
  const [defaultStatus, setDefaultStatus] = useState<LeadStatus>("cold");
  const [ownerChoices, setOwnerChoices] = useState<Map<string, string | null>>(() => new Map());
  const [countryChoices, setCountryChoices] = useState<Map<string, string | null>>(() => new Map());
  const [timeZone, setTimeZone] = useState(defaultTimeZone);
  const [preparing, setPreparing] = useState(false);

  useEffect(() => onChange({ timeZone }), [timeZone, onChange]);

  const statusCol = mapping.indexOf("status");
  const ownerCol = mapping.indexOf("owner");
  const countryCol = mapping.indexOf("country");
  const dateCol = mapping.indexOf("last_activity");
  const statuses = useMemo(() => distinctValues(records, statusCol, statusKey), [records, statusCol]);
  const owners = useMemo(() => distinctValues(records, ownerCol, ownerKey), [records, ownerCol]);
  const countries = useMemo(() => distinctValues(records, countryCol, countryKey), [records, countryCol]);
  const dateGuess = useMemo(
    () => (dateCol < 0 ? null : detectDateOrder(records.map((r) => r.cells[dateCol]))),
    [records, dateCol],
  );
  const countryOptions = useMemo(() => countriesByName(locale), [locale]);
  const [dateOrder, setDateOrder] = useState<DateOrder | null>(null);
  const order: DateOrder = dateOrder ?? (dateGuess ? suggestDateOrder(dateGuess) : "dmy");

  const matchOwner = useMemo(() => createOwnerMatcher(team), [team]);
  const unknownStatuses = statuses.filter((s) => !suggestStatus(s.label) && !statusChoices.has(s.key));
  const unknownCountries = countries.filter((c) => !matchCountry(c.label));
  const nameMissing = !mapping.includes("name");
  const blocked = nameMissing ? t("needName") : unknownStatuses.length > 0 ? t("needStatus", { count: unknownStatuses.length }) : null;

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
    if (blocked || preparing) return;
    saveMapping(fingerprint, mapping);
    setPreparing(true);
    // Cleans every row in slices of 1,000, letting the page answer in between (tens of thousands of rows take a moment).
    const rows = await normalise({
      mapping,
      team,
      dateOrder: order,
      timeZone,
      statusChoices,
      defaultStatus,
      ownerChoices,
      countryChoices,
    });
    setPreparing(false);
    onCheck(rows);
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
        <p className="text-muted-foreground">
          {t("fileLine", {
            file: file.name,
            rows: format.number(file.parsed.rowCount),
            columns: format.number(headers.length),
            separator: file.parsed.delimiter === "\t" ? t("tab") : file.parsed.delimiter,
          })}
        </p>
        {file.encoding === "windows-1252" ? <Notice tone="amber">{t("encodingNotice")}</Notice> : null}
        {sameFileBefore ? (
          <Notice tone="amber">
            {t("sameFile", {
              date: format.dateTime(new Date(sameFileBefore.created_at), { dateStyle: "medium" }),
              count: format.number(sameFileBefore.imported),
            })}
          </Notice>
        ) : null}
        {restored ? <p className="text-sm text-muted-foreground">{t("restored")}</p> : null}
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
          hint={t("ownerHint", { matched: owners.filter((o) => matchOwner(o.label)).length, total: owners.length })}
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
          <ValueRow label={t("dateOrder")} count={null}>
            <Select aria-label={t("dateOrder")} value={order} onChange={(e) => setDateOrder(e.target.value as DateOrder)}>
              <option value="dmy">{t("dmy")}</option>
              <option value="mdy">{t("mdy")}</option>
            </Select>
          </ValueRow>
          <ValueRow label={t("timeZone")} count={null}>
            <Select aria-label={t("timeZone")} value={timeZone} onChange={(e) => setTimeZone(e.target.value)}>
              {[...new Set([defaultTimeZone, ...timeZones])].map((zone) => (
                <option key={zone} value={zone}>
                  {zone.replace(/_/g, " ")}
                </option>
              ))}
            </Select>
          </ValueRow>
        </ValueSection>
      ) : null}

      <div className="sticky bottom-24 z-10 -mx-4 flex flex-col gap-3 border-t border-border bg-card px-4 pt-4 pb-2 sm:static sm:mx-0 sm:flex-row sm:items-center sm:justify-between sm:border-0 sm:p-0">
        <Button variant="link" onClick={onBack}>
          {t("back")}
        </Button>
        <div className="flex flex-col gap-2 sm:items-end">
          <Button variant="neutral" onClick={() => void check()} disabled={Boolean(blocked) || preparing}>
            {preparing ? t("preparing") : t("check")}
            {modKey ? <Kbd className="max-sm:hidden">{`${modKey} ↩`}</Kbd> : null}
          </Button>
          {blocked ? <p className="text-sm text-muted-foreground">{blocked}</p> : null}
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
    <li className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_220px] sm:items-center">
      <div className="flex min-w-0 items-center gap-2">
        <label htmlFor={id} className="truncate font-bold" title={header}>
          {header}
        </label>
        {matched ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-sm bg-muted px-2 py-0.5 text-xs">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-status-green" />
            {t("matched")}
          </span>
        ) : null}
      </div>
      <p className="min-w-0 truncate text-sm text-muted-foreground" title={examples.join(" · ")}>
        {examples.length ? examples.join(" · ") : t("emptyColumn")}
      </p>
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
        <p className="text-sm text-muted-foreground">{hint}</p>
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
  children,
}: {
  label: string;
  count: number | null;
  needsChoice?: boolean;
  amber?: boolean;
  children: React.ReactNode;
}) {
  const t = useTranslations("Import.match");
  const format = useFormatter();
  return (
    <li className="grid grid-cols-1 gap-2 p-4 sm:grid-cols-[minmax(0,1fr)_220px] sm:items-center">
      <div className="flex min-w-0 items-center gap-2">
        {needsChoice || amber ? (
          <span aria-hidden="true" className={needsChoice ? "size-1.5 shrink-0 rounded-full bg-status-red" : "size-1.5 shrink-0 rounded-full bg-status-amber"} />
        ) : null}
        <span className="truncate" title={label}>
          {label}
        </span>
        {count !== null ? (
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{t("rowsCount", { count, formatted: format.number(count) })}</span>
        ) : null}
        {needsChoice ? <span className="sr-only">{t("needsChoice")}</span> : null}
      </div>
      {children}
    </li>
  );
}

function Notice({ tone, children }: { tone: "amber" | "red"; children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-sm">
      <span aria-hidden="true" className={tone === "amber" ? "mt-1.5 size-1.5 shrink-0 rounded-full bg-status-amber" : "mt-1.5 size-1.5 shrink-0 rounded-full bg-status-red"} />
      <span>{children}</span>
    </p>
  );
}
