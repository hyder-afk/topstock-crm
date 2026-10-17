"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { FileUp } from "lucide-react";
import { ProgressBar } from "@/components/import/progress";
import { readStockFile, type LoadedStockFile } from "@/components/stock-import/read-stock-file";
import { ImportFileError } from "@/lib/import";
import { STOCK_LIMITS } from "@/lib/stock-import";
import { cn } from "@/lib/utils";

type ReadState = { kind: "idle" } | { kind: "reading"; done: number; total: number } | { kind: "error"; code: string; rowNo: number | null };

// Step 1 of a stock import: pick the stock sheet (CSV). It is read in this browser only and checked against the limits
// (5,000 rows); leaving the step stops a read that is still running. The Day 3b Choose step with the stock texts.
export function StockChoose({
  headingRef,
  announce,
  onLoaded,
}: {
  headingRef: React.Ref<HTMLHeadingElement>;
  announce: (text: string) => void;
  onLoaded: (file: LoadedStockFile) => void;
}) {
  const t = useTranslations("StockImport.choose");
  const te = useTranslations("Import.choose.errors");
  const format = useFormatter();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<ReadState>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const reading = useRef<AbortController | null>(null);

  useEffect(() => () => reading.current?.abort(), []);

  const read = async (picked: File | undefined) => {
    if (!picked) return;
    // A new pick replaces the file still being read (quickly correcting a wrong pick loads the right one).
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    try {
      setState({ kind: "reading", done: 0, total: picked.size });
      announce(t("reading"));
      const loaded = await readStockFile(picked, {
        signal: controller.signal,
        onProgress: (p) => setState({ kind: "reading", done: p.done, total: p.total }),
      });
      if (controller.signal.aborted) return;
      setState({ kind: "idle" });
      onLoaded(loaded);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ImportFileError) setState({ kind: "error", code: cause.code, rowNo: cause.rowNo });
      else setState({ kind: "error", code: "unreadable", rowNo: null });
    } finally {
      if (reading.current === controller) reading.current = null;
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h2 ref={headingRef} id="stock-step-heading" tabIndex={-1} className="text-xl font-bold tracking-[-0.03em] text-balance focus:outline-none">
          {t("title")}
        </h2>
        <p className="max-w-[65ch] text-muted-foreground">{t("body")}</p>
      </div>
      <label
        htmlFor={inputId}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        // Only when the pointer leaves the zone itself, not when it crosses into the icon or text inside (Apple audit #12:
        // the highlight held steady, as on the Files tab).
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void read(event.dataTransfer.files[0]);
        }}
        className={cn(
          "group flex cursor-pointer flex-col items-start gap-4 rounded-lg border border-dashed border-border bg-background p-6 transition-[border-color,background-color] sm:p-8",
          "hover:border-foreground/40 active:bg-muted",
          // The file field itself is visually hidden, so the whole zone carries the keyboard focus ring.
          "has-[:focus-visible]:border-foreground/60 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
          dragging && "border-foreground/60 bg-muted",
        )}
      >
        <span className="grid size-11 place-items-center rounded-md bg-muted text-muted-foreground">
          <FileUp aria-hidden="true" strokeWidth={1.75} className="size-[22px]" />
        </span>
        <span className="flex flex-col gap-1">
          <span className="font-bold">
            <span className="max-sm:hidden">{t("drop")}</span>
            <span className="sm:hidden">{t("pick")}</span>
          </span>
          <span className="text-sm text-muted-foreground">{t("limits", { rows: format.number(STOCK_LIMITS.maxDataRows) })}</span>
          <span className="text-sm text-muted-foreground">{t("excelHint")}</span>
        </span>
        {/* Never disabled while reading (a disabled field would drop the keyboard focus); a second pick replaces the first. */}
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          name="file"
          accept=".csv,.txt,text/csv,text/plain"
          className="sr-only"
          aria-busy={state.kind === "reading" || undefined}
          onChange={(event) => void read(event.target.files?.[0])}
        />
        <span className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 font-bold text-primary-foreground transition-transform duration-150 group-active:scale-[0.97]">
          {t("button")}
        </span>
      </label>
      {state.kind === "reading" ? (
        <div className="flex flex-col gap-2">
          <ProgressBar value={state.done} max={state.total} label={t("reading")} />
          <p className="text-sm text-muted-foreground">{t("reading")}</p>
        </div>
      ) : null}
      {state.kind === "error" ? (
        <div role="alert" className="flex items-start gap-2 rounded-md bg-muted px-4 py-3">
          <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-status-red" />
          <p>{te(state.code as "empty", { row: state.rowNo ?? 0, rows: format.number(STOCK_LIMITS.maxDataRows) })}</p>
        </div>
      ) : null}
      <p className="text-sm text-muted-foreground">{t("safe")}</p>
    </div>
  );
}
