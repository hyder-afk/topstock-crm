"use client";

import { useEffect, useEffectEvent, useId, useMemo, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Select } from "@/components/ui/select";
import { Notice, ValueRow, ValueSection } from "@/components/stock-import/bits";
import { readStockMapping, saveStockMapping } from "@/components/stock-import/mapping-store";
import type { LoadedStockFile } from "@/components/stock-import/read-stock-file";
import {
  LOCATION_KINDS,
  STOCK_TARGETS,
  StockRulesError,
  assignStockTarget,
  autoMapStock,
  detectNumberStyle,
  distinctStatuses,
  normaliseStockRecords,
  parseNumber,
  tallyStock,
  type LocationKind,
  type NumberStyle,
  type StockNormalised,
  type StockTarget,
} from "@/lib/stock-import";
import { useModKey } from "@/lib/use-platform";

export type StockChoices = {
  mapping: StockTarget[];
  style: NumberStyle;
  statusChoices: Map<string, LocationKind>;
  defaultLocation: LocationKind;
};

const NUMBER_FIELDS: ReadonlySet<StockTarget> = new Set(["quantity", "price_min", "price_max", "total_cost", "pieces_per_carton"]);

// Step 2: which column feeds which field, the number style (with a live example from the file), and where each STATUS
// spelling goes. Haider's header row needs no click. The live line under the button counts the rows as they would be
// sent; Continue is disabled with the reason while a choice is missing.
export function StockMatch({
  file,
  headingRef,
  onContinue,
  onBack,
}: {
  file: LoadedStockFile;
  headingRef: React.Ref<HTMLHeadingElement>;
  onContinue: (choices: StockChoices, rows: StockNormalised[]) => void;
  onBack: () => void;
}) {
  const t = useTranslations("StockImport.match");
  const tl = useTranslations("StockImport.places");
  const format = useFormatter();
  const modKey = useModKey();
  const { headers, records, delimiter } = file.parsed;
  const suggested = useMemo(() => autoMapStock(headers), [headers]);
  const remembered = useMemo(() => readStockMapping(file.headerKey, headers.length), [file.headerKey, headers.length]);
  const [mapping, setMapping] = useState<StockTarget[]>(() => remembered ?? suggested.targets);
  const numberCells = useMemo(() => {
    const cells: string[] = [];
    for (const r of records.slice(0, 2000)) mapping.forEach((target, i) => NUMBER_FIELDS.has(target) && cells.push(r.cells[i] ?? ""));
    return cells;
  }, [records, mapping]);
  const guess = useMemo(() => detectNumberStyle(numberCells, delimiter), [numberCells, delimiter]);
  const [styleChoice, setStyleChoice] = useState<NumberStyle | null>(null);
  const style = styleChoice ?? (guess.ambiguous ? null : guess.style);
  const statusCol = mapping.indexOf("status");
  const statuses = useMemo(
    () => (statusCol >= 0 ? distinctStatuses(records.map((r) => r.cells[statusCol] ?? "")) : { values: [], blanks: records.length }),
    [records, statusCol],
  );
  const [statusChoices, setStatusChoices] = useState<Map<string, LocationKind>>(new Map());
  const [defaultLocation, setDefaultLocation] = useState<LocationKind>("warehouse");
  const unknownLeft = statuses.values.some((s) => !s.suggested && !statusChoices.has(s.key));

  const blocked = !mapping.includes("name")
    ? t("needName")
    : !mapping.includes("quantity")
      ? t("needQuantity")
      : style === null
        ? t("needStyle")
        : unknownLeft
          ? t("needStatus")
          : null;

  // The rows as they would be sent with these choices (5,000 rows take a few milliseconds).
  const preview = useMemo(() => {
    if (blocked || style === null) return null;
    try {
      const rows = normaliseStockRecords(records, { mapping, style, statusChoices, defaultLocation });
      return { rows, tally: tallyStock(rows) };
    } catch (cause) {
      if (cause instanceof StockRulesError) return null;
      throw cause;
    }
  }, [blocked, records, mapping, style, statusChoices, defaultLocation]);

  // A live example of the number style: the first number cell with a separator, read both ways.
  const example = useMemo(() => {
    const raw = numberCells.find((c) => /\d[\s  .,']\d/.test(c)) ?? numberCells.find((c) => /\d/.test(c));
    if (!raw || style === null) return null;
    const read = parseNumber(raw, style);
    return { raw: raw.trim(), read: read.kind === "number" ? format.number(read.value, { maximumFractionDigits: 4 }) : t("notANumber") };
  }, [numberCells, style, format, t]);

  const examples = useMemo(() => {
    const found: string[][] = headers.map(() => []);
    for (const record of records) {
      let full = true;
      found.forEach((values, column) => {
        if (values.length >= 3) return;
        full = false;
        const value = record.cells[column]?.trim();
        if (value) values.push(value);
      });
      if (full) break;
    }
    return found;
  }, [headers, records]);

  const proceed = () => {
    if (blocked || !preview || style === null) return;
    saveStockMapping(file.headerKey, mapping);
    onContinue({ mapping, style, statusChoices, defaultLocation }, preview.rows);
  };
  const onShortcut = useEffectEvent(() => proceed());
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

  const countsId = useId();
  const styleId = useId();
  const statusLine =
    blocked ??
    (preview
      ? t("previewCounts", {
          ready: preview.tally.rows - preview.tally.rejected,
          readyFormatted: format.number(preview.tally.rows - preview.tally.rejected),
          rejected: preview.tally.rejected,
          rejectedFormatted: format.number(preview.tally.rejected),
        })
      : t("previewCounting"));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h2 ref={headingRef} id="stock-step-heading" tabIndex={-1} className="text-xl font-bold tracking-[-0.03em] text-balance focus:outline-none">
          {t("title")}
        </h2>
        <p className="max-w-[65ch] text-muted-foreground wrap-anywhere">
          {t("fileLine", {
            file: file.name,
            rows: file.parsed.rowCount,
            rowsFormatted: format.number(file.parsed.rowCount),
            columns: headers.length,
            columnsFormatted: format.number(headers.length),
          })}
        </p>
        {file.encoding === "windows-1252" ? <Notice tone="amber">{t("encodingNotice")}</Notice> : null}
        {remembered ? <p className="text-sm text-muted-foreground">{t("restored")}</p> : null}
      </div>

      <section className="flex flex-col gap-3">
        <h3 className="font-bold">{t("columnsTitle")}</h3>
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {headers.map((header, i) => (
            <ColumnRow
              key={`${i}-${header}`}
              header={header || t("noHeader", { n: i + 1 })}
              examples={examples[i]}
              value={mapping[i]}
              matched={suggested.matched[i] && suggested.targets[i] === mapping[i] && mapping[i] !== "ignore"}
              onChange={(target) => setMapping((m) => assignStockTarget(m, i, target))}
            />
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="font-bold">{t("numbersTitle")}</h3>
          <p id={styleId} className="max-w-[65ch] text-sm text-muted-foreground" aria-live="polite">
            {example ? t("numbersExample", { raw: example.raw, read: example.read }) : t("numbersHint")}
          </p>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_248px] sm:items-center">
          <label htmlFor={`${styleId}-select`} className="flex items-center gap-2">
            {style === null ? <span aria-hidden="true" className="size-1.5 rounded-full bg-status-red" /> : null}
            {t("numbersLabel")}
          </label>
          <Select
            id={`${styleId}-select`}
            value={style ?? ""}
            aria-invalid={style === null || undefined}
            aria-describedby={styleId}
            onChange={(e) => setStyleChoice(e.target.value as NumberStyle)}
          >
            {style === null ? <option value="">{t("choose")}</option> : null}
            <option value="fr">{t("styleFr")}</option>
            <option value="en">{t("styleEn")}</option>
          </Select>
        </div>
        {guess.ambiguous && styleChoice === null ? <Notice tone="amber">{t("styleAmbiguous")}</Notice> : null}
      </section>

      <ValueSection title={t("statusTitle")} hint={statusCol >= 0 ? t("statusHint") : t("noStatusColumn")}>
        {statuses.values.map((s) => {
          const value = statusChoices.get(s.key) ?? s.suggested ?? "";
          return (
            <ValueRow key={s.key} label={s.label} count={s.count} needsChoice={!value}>
              <Select
                aria-label={t("statusFor", { value: s.label })}
                value={value}
                aria-invalid={!value || undefined}
                onChange={(e) => setStatusChoices((m) => new Map(m).set(s.key, e.target.value as LocationKind))}
              >
                {!value ? <option value="">{t("choose")}</option> : null}
                {LOCATION_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {tl(k)}
                  </option>
                ))}
              </Select>
            </ValueRow>
          );
        })}
        <ValueRow label={t("blankStatus")} count={statuses.blanks > 0 ? statuses.blanks : null} amber={statuses.blanks > 0}>
          <Select aria-label={t("blankStatus")} value={defaultLocation} onChange={(e) => setDefaultLocation(e.target.value as LocationKind)}>
            {LOCATION_KINDS.map((k) => (
              <option key={k} value={k}>
                {tl(k)}
              </option>
            ))}
          </Select>
        </ValueRow>
      </ValueSection>

      {preview?.tally.swapped ? <Notice tone="amber">{t("swapped")}</Notice> : null}

      <div className="z-10 flex flex-col gap-3 rounded-lg border border-border bg-background/95 p-4 backdrop-blur sm:sticky sm:bottom-24 sm:flex-row sm:items-center sm:justify-between">
        <p id={countsId} role="status" aria-atomic="true" className="text-sm text-muted-foreground">
          {statusLine}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="quiet" onClick={onBack}>
            {t("back")}
          </Button>
          <Button variant="neutral" onClick={proceed} disabled={Boolean(blocked) || !preview} aria-describedby={countsId}>
            {t("check")}
            {modKey ? <Kbd className="max-sm:hidden">{`${modKey} ↩`}</Kbd> : null}
          </Button>
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
  value: StockTarget;
  matched: boolean;
  onChange: (target: StockTarget) => void;
}) {
  const t = useTranslations("StockImport.match");
  const id = useId();
  return (
    <li className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_248px] sm:items-center xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_248px]">
      <div className="flex min-w-0 flex-col gap-1 xl:contents">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <label htmlFor={id} className="min-w-0 font-bold wrap-anywhere" translate="no">
            {header}
          </label>
          {matched ? (
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-sm bg-muted px-2 py-0.5 text-xs">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-status-green" />
              {t("matched")}
            </span>
          ) : null}
        </div>
        <p className="min-w-0 text-sm text-muted-foreground wrap-anywhere" translate="no">
          {examples.length ? examples.join(" · ") : t("emptyColumn")}
        </p>
      </div>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value as StockTarget)}>
        {STOCK_TARGETS.map((target) => (
          <option key={target} value={target}>
            {t(`targets.${target}`)}
          </option>
        ))}
      </Select>
    </li>
  );
}
