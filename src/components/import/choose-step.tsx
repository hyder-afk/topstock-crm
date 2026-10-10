"use client";

import { useId, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { FileUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProgressBar } from "@/components/import/progress";
import { ImportFileError, checkFileMeta, decodeBytes, parseCsvText, sha256Hex, type ParsedCsv } from "@/lib/import";
import type { ImportBatch } from "@/lib/import-server";
import { cn } from "@/lib/utils";

export type LoadedFile = {
  name: string;
  size: number;
  sha256: string;
  encoding: "utf-8" | "windows-1252";
  parsed: ParsedCsv;
};

type ReadState = { kind: "idle" } | { kind: "reading"; done: number; total: number } | { kind: "error"; code: string; rowNo: number | null };

// Step 1: pick a CSV file. It is read in this browser only (never uploaded as a file): decoded once (UTF-8, or Western
// European if that fails), parsed in slices so the screen keeps responding, and checked against the limits.
export function ChooseStep({
  headingRef,
  resume,
  onCancelResume,
  onLoaded,
}: {
  headingRef: React.Ref<HTMLHeadingElement>;
  resume: ImportBatch | null;
  onCancelResume: () => void;
  onLoaded: (file: LoadedFile) => void;
}) {
  const t = useTranslations("Import.choose");
  const format = useFormatter();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<ReadState>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);

  const read = async (picked: File | undefined) => {
    if (!picked || state.kind === "reading") return;
    try {
      checkFileMeta(picked);
      setState({ kind: "reading", done: 0, total: picked.size });
      const bytes = new Uint8Array(await picked.arrayBuffer());
      const decoded = decodeBytes(bytes);
      const sha256 = await sha256Hex(bytes);
      if (resume && resume.file_sha256 && resume.file_sha256 !== sha256) {
        setState({ kind: "error", code: "not_same_file", rowNo: null });
        return;
      }
      const parsed = await parseCsvText(decoded.text, {
        sepHint: decoded.sepHint,
        onProgress: (p) => setState({ kind: "reading", done: p.done, total: p.total }),
      });
      setState({ kind: "idle" });
      onLoaded({ name: picked.name, size: picked.size, sha256, encoding: decoded.encoding, parsed });
    } catch (cause) {
      if (cause instanceof ImportFileError) setState({ kind: "error", code: cause.code, rowNo: cause.rowNo });
      else setState({ kind: "error", code: "unreadable", rowNo: null });
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h2 ref={headingRef} id="import-step-heading" tabIndex={-1} className="text-xl font-bold tracking-[-0.03em] text-balance focus:outline-none">
          {resume ? t("resumeTitle", { file: resume.filename }) : t("title")}
        </h2>
        <p className="max-w-[65ch] text-muted-foreground">{resume ? t("resumeBody") : t("body")}</p>
      </div>
      <label
        htmlFor={inputId}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void read(event.dataTransfer.files[0]);
        }}
        className={cn(
          "flex cursor-pointer flex-col items-start gap-4 rounded-lg border border-dashed border-border bg-background p-6 transition-colors sm:p-8",
          "focus-within:border-foreground/60 hover:border-foreground/40",
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
          <span className="text-sm text-muted-foreground">{t("limits", { rows: format.number(50000) })}</span>
          <span className="text-sm text-muted-foreground">{t("excelHint")}</span>
        </span>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          name="file"
          accept=".csv,.txt,text/csv,text/plain"
          className="sr-only"
          disabled={state.kind === "reading"}
          onChange={(event) => void read(event.target.files?.[0])}
        />
        <span className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 font-bold text-primary-foreground">
          {t("button")}
        </span>
      </label>
      {state.kind === "reading" ? (
        <div className="flex flex-col gap-2" aria-live="polite">
          <ProgressBar value={state.done} max={state.total} label={t("reading")} />
          <p className="text-sm text-muted-foreground">{t("reading")}</p>
        </div>
      ) : null}
      {state.kind === "error" ? (
        <div role="alert" className="flex items-start gap-2 rounded-md bg-muted px-4 py-3">
          <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-status-red" />
          <p>{t(`errors.${state.code}`, { row: state.rowNo ?? 0, rows: format.number(50000) })}</p>
        </div>
      ) : null}
      <p className="text-sm text-muted-foreground">{t("safe")}</p>
      {resume ? (
        <div>
          <Button variant="link" onClick={onCancelResume}>
            {t("resumeCancel")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
