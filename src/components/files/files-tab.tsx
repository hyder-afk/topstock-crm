"use client";

import { useCallback, useId, useRef, useState } from "react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { FileSpreadsheet, FileText, FileType2, Image as ImageIcon, MoreHorizontal, Upload, X } from "lucide-react";
import { abortUpload, beginUpload, deleteFile, finishUpload } from "@/app/(app)/leads/[id]/file-actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, phoneSheet } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/toast";
import { filesKey, sizeParts, useFiles } from "@/components/files/use-files";
import type { ActionFailure } from "@/lib/db-errors";
import { splitName } from "@/lib/files/name";
import { checkLocalFile, uploadBytes } from "@/lib/files/upload";
import { ACCEPT, FILES_PER_DROP, TEAM_QUOTA_BYTES, fileKind, opensInline, type FileKind, type FileMime, type FilesPage, type LeadFile } from "@/lib/files/types";
import { personName } from "@/lib/leads";
import { springs } from "@/lib/motion";
import { publicEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

// The Files tab (Day 4 design 7.6 and 5.7). A drop zone with a real button ("Add file" on phones), then the files,
// newest first: type, name (the end and the extension always shown), size, who added it and when, and a menu with
// Open (PDF and images, in the browser's viewer), Download and Delete (a fresh code). Admins and managers see the team's
// space. An upload shows a real progress bar with Cancel, then "Checking the file…", then the row; a file refused says
// why on its own line. Rows link with plain <a> to /api/files/<id>, never Next Link, so hovering never prefetches, and
// the 60-second link to the bytes exists only in that route's redirect.

type StepUp = { ensureFresh: (minSeconds?: number) => Promise<boolean>; requireFresh: () => Promise<boolean> };
type UploadError = "tooBig" | "empty" | "type" | "mismatch" | "quota" | "rateLimited" | "tooManyPending" | "connection" | "tooMany" | "unavailable";
type Upload = {
  key: number;
  name: string;
  size: number;
  mime: FileMime | null;
  phase: "uploading" | "checking" | "error";
  progress: number;
  error?: UploadError;
  controller: AbortController;
};

const kindIcon: Record<FileKind, typeof FileText> = { pdf: FileText, image: ImageIcon, word: FileType2, excel: FileSpreadsheet };

function failureToUpload(f: ActionFailure): UploadError {
  switch (f.error) {
    case "quota":
      return "quota";
    case "rate_limited":
      return "rateLimited";
    case "busy":
      return "tooManyPending";
    case "type_mismatch":
      return "mismatch";
    case "invalid":
      return f.hint === "file_size" ? "tooBig" : "type";
    default:
      return "unavailable";
  }
}

export function useFileSize() {
  const format = useFormatter();
  return useCallback(
    (bytes: number) => {
      const { value, unit, digits } = sizeParts(bytes);
      return format.number(value, { style: "unit", unit, unitDisplay: "short", maximumFractionDigits: digits, minimumFractionDigits: digits });
    },
    [format],
  );
}

export function FilesTab({ leadId, initial, stepUp }: { leadId: string; initial: FilesPage | null; stepUp: StepUp }) {
  const t = useTranslations("Files");
  const format = useFormatter();
  const now = useNow();
  const size = useFileSize();
  const reduce = useReducedMotion();
  const queryClient = useQueryClient();
  const toast = useToast();
  const files = useFiles(leadId, initial);
  const inputId = useId();
  const limitsId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const seq = useRef(0);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [over, setOver] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [confirm, setConfirm] = useState<LeadFile | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  const rows = files.data?.pages.flatMap((p) => p.files) ?? [];
  const usage = files.data?.pages[0]?.usage ?? null;

  const patch = useCallback((key: number, change: Partial<Upload>) => {
    setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...change } : u)));
  }, []);
  // An item leaving the list takes its focused button with it: the focus goes to "Choose files" instead of the page.
  const drop = useCallback((key: number) => {
    const el = document.querySelector(`[data-upload-key="${key}"]`);
    const hadFocus = !!el && el.contains(document.activeElement);
    setUploads((list) => list.filter((u) => u.key !== key));
    if (hadFocus) requestAnimationFrame(() => chooseRef.current?.focus());
  }, []);

  const uploadOne = useCallback(
    async (file: File) => {
      seq.current += 1;
      const key = seq.current;
      const controller = new AbortController();
      setUploads((list) => [...list, { key, name: file.name, size: file.size, mime: null, phase: "uploading", progress: 0, controller }]);
      const fail = (error: UploadError) => {
        patch(key, { phase: "error", error });
        setAnnounce(t("announce.failed", { name: file.name }));
      };
      const local = await checkLocalFile(file);
      if (!local.ok) return fail(local.reason);
      patch(key, { mime: local.mime });
      const begun = await beginUpload({ leadId, name: file.name, mime: local.mime, size: file.size }).catch(() => null);
      if (!begun) return fail("connection");
      if (!begun.ok) return fail(failureToUpload(begun));
      setAnnounce(t("announce.uploading", { name: begun.data.name }));
      const { data } = await createClient().auth.getSession();
      const token = data.session?.access_token;
      if (!token) {
        await abortUpload({ id: begun.data.id }).catch(() => null);
        return fail("unavailable");
      }
      const outcome = await uploadBytes({
        supabaseUrl: publicEnv.NEXT_PUBLIC_SUPABASE_URL,
        anonKey: publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        token,
        path: begun.data.path,
        file,
        mime: local.mime,
        onProgress: (progress) => patch(key, { progress }),
        signal: controller.signal,
      });
      if (outcome !== "done") {
        await abortUpload({ id: begun.data.id }).catch(() => null);
        if (outcome === "cancelled") {
          setAnnounce(t("announce.cancelled", { name: begun.data.name }));
          return drop(key);
        }
        return fail(outcome === "failed" ? "connection" : "unavailable");
      }
      patch(key, { phase: "checking", progress: 1 });
      setAnnounce(t("checking"));
      const finished = await finishUpload({ id: begun.data.id }).catch(() => null);
      if (!finished) return fail("connection");
      if (!finished.ok) return fail(failureToUpload(finished));
      await queryClient.invalidateQueries({ queryKey: filesKey(leadId) });
      setAnnounce(t("announce.added", { name: finished.data.name }));
      drop(key);
    },
    [leadId, patch, drop, queryClient, t],
  );

  // Up to 5 files at a time, one after the other (the server runs one action at a time per tab anyway).
  const take = useCallback(
    async (list: FileList | null) => {
      if (!list || list.length === 0) return;
      const chosen = Array.from(list);
      for (const extra of chosen.slice(FILES_PER_DROP)) {
        seq.current += 1;
        setUploads((u) => [...u, { key: seq.current, name: extra.name, size: extra.size, mime: null, phase: "error", progress: 0, error: "tooMany", controller: new AbortController() }]);
      }
      for (const file of chosen.slice(0, FILES_PER_DROP)) await uploadOne(file);
    },
    [uploadOne],
  );

  const remove = async (file: LeadFile) => {
    setConfirm(null);
    if (file.status === "ready" && !(await stepUp.ensureFresh(60))) return;
    setBusyIds((s) => new Set(s).add(file.id));
    let res = await deleteFile({ id: file.id }).catch(() => ({ ok: false as const, error: "unavailable" as const }));
    if (!res.ok && res.error === "step_up" && (await stepUp.requireFresh())) {
      res = await deleteFile({ id: file.id }).catch(() => ({ ok: false as const, error: "unavailable" as const }));
    }
    setBusyIds((s) => {
      const next = new Set(s);
      next.delete(file.id);
      return next;
    });
    if (!res.ok) {
      if (res.error !== "step_up") toast.show(t("errors.deleteFailed"));
      await queryClient.invalidateQueries({ queryKey: filesKey(leadId) });
      return;
    }
    queryClient.setQueryData<InfiniteData<FilesPage>>(filesKey(leadId), (old) =>
      old ? { ...old, pages: old.pages.map((p) => ({ ...p, files: p.files.filter((f) => f.id !== file.id) })) } : old,
    );
    void queryClient.invalidateQueries({ queryKey: filesKey(leadId) });
    toast.show(t("deleted", { name: file.name }));
    requestAnimationFrame(() => headingRef.current?.focus());
  };

  const date = (iso: string) => {
    const d = new Date(iso);
    const thisYear = d.getFullYear() === now.getFullYear(); // the request's shared "now": server and browser agree
    return format.dateTime(d, thisYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
  };

  return (
    <section aria-labelledby={`${inputId}-title`} className="flex min-w-0 flex-col gap-4 rounded-lg bg-card p-4 sm:p-5">
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2 ref={headingRef} tabIndex={-1} id={`${inputId}-title`} className="text-sm font-bold text-muted-foreground">
          {t("title")}
        </h2>
        {usage !== null ? (
          <p className="font-mono text-xs text-muted-foreground">{t("usage", { used: size(usage), total: size(TEAM_QUOTA_BYTES) })}</p>
        ) : null}
      </div>

      {/* The drop zone: a real button inside, so it works without a mouse; dropping is an extra. */}
      <div
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void take(e.dataTransfer.files);
        }}
        className={cn(
          "flex flex-col items-stretch gap-3 rounded-md border border-dashed border-border p-4 transition-colors duration-150 sm:flex-row sm:items-center sm:gap-4 sm:p-5",
          over && "border-foreground bg-muted",
        )}
      >
        <span aria-hidden="true" className="hidden size-11 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground sm:grid">
          <Upload strokeWidth={1.75} className="size-5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="hidden font-bold sm:block">{t("drop")}</p>
          <p id={limitsId} className="text-sm text-muted-foreground">
            {t("limits")}
          </p>
        </div>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          multiple
          accept={ACCEPT}
          aria-label={t("choose")}
          aria-describedby={limitsId}
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => {
            const list = e.currentTarget.files;
            void take(list).finally(() => {
              if (inputRef.current) inputRef.current.value = "";
            });
          }}
        />
        <Button ref={chooseRef} variant="quiet" aria-describedby={limitsId} onClick={() => inputRef.current?.click()} className="w-full sm:w-auto">
          <span className="sm:hidden">{t("add")}</span>
          <span className="hidden sm:inline">{t("choose")}</span>
        </Button>
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>

      {uploads.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label={t("uploadsLabel")}>
          {uploads.map((u) => (
            <li key={u.key} data-upload-key={u.key} className="flex min-w-0 flex-col gap-2 rounded-md bg-muted/60 p-3">
              <div className="flex min-w-0 items-center gap-3">
                <FileName name={u.name} className="flex-1 font-bold" />
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{size(u.size)}</span>
                {u.phase === "uploading" ? (
                  <Button variant="link" className="min-h-11 shrink-0 text-sm sm:min-h-9" onClick={() => u.controller.abort()}>
                    {t("cancel")}
                  </Button>
                ) : u.phase === "error" ? (
                  <button
                    type="button"
                    aria-label={t("dismiss", { name: u.name })}
                    onClick={() => drop(u.key)}
                    className="grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground transition-[color,transform] duration-150 hover:text-foreground active:scale-[0.97] sm:size-9"
                  >
                    <X aria-hidden="true" strokeWidth={1.75} className="size-4" />
                  </button>
                ) : null}
              </div>
              {u.phase === "error" ? (
                <p className="flex items-start gap-2 text-sm">
                  <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-status-red" />
                  <span>{u.error === "mismatch" && u.mime ? t(`errors.mismatch.${fileKind(u.mime)}`) : t(`errors.${u.error ?? "unavailable"}`)}</span>
                </p>
              ) : (
                <div className="flex flex-col gap-1">
                  <div
                    role="progressbar"
                    aria-label={t("progressLabel", { name: u.name })}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(u.progress * 100)}
                    aria-valuetext={u.phase === "checking" ? t("checking") : `${Math.round(u.progress * 100)} %`}
                    className="h-1.5 overflow-hidden rounded-full bg-background"
                  >
                    <motion.div
                      className="h-full origin-left rounded-full bg-foreground"
                      initial={{ scaleX: 0 }}
                      animate={{ scaleX: u.progress }}
                      transition={reduce ? { duration: 0 } : springs.smooth}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">{u.phase === "checking" ? t("checking") : t("uploading")}</p>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {files.isPending ? (
        <ul aria-hidden="true" className="flex flex-col gap-2">
          {Array.from({ length: 3 }, (_, i) => (
            <li key={i} className="flex min-h-14 items-center gap-3">
              <div className="size-11 shrink-0 rounded-md bg-muted motion-safe:animate-pulse" />
              <div className="flex flex-1 flex-col gap-1.5">
                <div className="h-5 w-2/3 max-w-72 rounded-sm bg-muted motion-safe:animate-pulse" />
                <div className="h-4 w-1/2 max-w-56 rounded-sm bg-muted motion-safe:animate-pulse" />
              </div>
            </li>
          ))}
        </ul>
      ) : files.isError && rows.length === 0 ? (
        <div role="alert" className="flex flex-col items-start gap-2">
          <p className="text-sm font-bold">{t("error")}</p>
          <Button
            variant="quiet"
            onClick={() => {
              void files.refetch().then(() => headingRef.current?.focus());
            }}
          >
            {t("retry")}
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul aria-labelledby={`${inputId}-title`} className="-mx-1 flex flex-col">
          <AnimatePresence initial={false}>
            {rows.map((f) => (
              <motion.li
                key={f.id}
                layout={reduce ? false : "position"}
                initial={reduce ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0 }}
                transition={springs.smooth}
              >
                <FileRow
                  file={f}
                  sizeLabel={size(f.size)}
                  dateLabel={date(f.created_at)}
                  busy={busyIds.has(f.id)}
                  onDelete={() => (f.status === "deleting" ? void remove(f) : setConfirm(f))}
                />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      {files.hasNextPage ? (
        <Button variant="quiet" className="self-start" aria-disabled={files.isFetchingNextPage || undefined} onClick={() => void files.fetchNextPage()}>
          {t("loadOlder")}
        </Button>
      ) : null}

      <Dialog open={confirm !== null} onOpenChange={(open) => (open ? null : setConfirm(null))}>
        <DialogContent className={cn(phoneSheet, "sm:w-[min(440px,calc(100%-32px))]")}>
          <div className="flex flex-col gap-5 p-6">
            <div className="flex flex-col gap-2">
              <DialogTitle className="text-xl font-bold text-balance">{t("deleteConfirm.title")}</DialogTitle>
              <DialogDescription className="text-muted-foreground [overflow-wrap:anywhere]">
                {t("deleteConfirm.body", { name: confirm?.name ?? "" })}
              </DialogDescription>
            </div>
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <Button variant="quiet" onClick={() => setConfirm(null)} autoFocus>
                {t("deleteConfirm.cancel")}
              </Button>
              <Button variant="neutral" onClick={() => confirm && void remove(confirm)}>
                {t("deleteConfirm.confirm")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** A name that keeps its end: the stem is cut with an ellipsis, the extension always shows. */
function FileName({ name, className }: { name: string; className?: string }) {
  const { stem, ext } = splitName(name);
  return (
    <span className={cn("flex min-w-0", className)} title={name} translate="no">
      <span dir="auto" className="truncate">
        {stem}
      </span>
      <span className="shrink-0">{ext}</span>
    </span>
  );
}

function FileRow({
  file,
  sizeLabel,
  dateLabel,
  busy,
  onDelete,
}: {
  file: LeadFile;
  sizeLabel: string;
  dateLabel: string;
  busy: boolean;
  onDelete: () => void;
}) {
  const t = useTranslations("Files");
  const Icon = kindIcon[fileKind(file.mime)];
  const inline = opensInline(file.mime);
  const href = `/api/files/${file.id}?disposition=${inline ? "inline" : "attachment"}`;
  const download = `/api/files/${file.id}?disposition=attachment`;
  const who = file.is_mine ? t("you") : personName({ first_name: file.uploader_first_name, last_name: file.uploader_last_name }) || t("someone");
  const deleting = file.status === "deleting";

  return (
    <div className="flex min-h-14 min-w-0 items-center gap-3 rounded-md px-1 py-1.5">
      <span aria-hidden="true" className="grid size-11 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
        <Icon strokeWidth={1.75} className="size-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {deleting ? (
          <FileName name={file.name} className="text-muted-foreground line-through" />
        ) : (
          // A plain link (never Next Link: no prefetch on hover). PDF and images open in a new tab, Office files download.
          <a
            href={href}
            {...(inline ? { target: "_blank", rel: "noopener noreferrer" } : {})}
            className="flex min-h-6 min-w-0 rounded-sm font-bold underline-offset-4 hover:underline"
          >
            <FileName name={file.name} />
            {inline ? <span className="sr-only"> {t("opensNewTab")}</span> : null}
          </a>
        )}
        <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
          {deleting ? (
            <>
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-status-amber" />
                {t("stuckDeleting")}
              </span>
              <span aria-hidden="true">·</span>
              <button type="button" onClick={onDelete} disabled={busy} className="min-h-11 font-bold text-foreground underline-offset-4 hover:underline disabled:opacity-60 sm:min-h-0">
                {t("retryDelete")}
              </button>
            </>
          ) : (
            <>
              <span className="font-mono text-xs">{sizeLabel}</span>
              <span aria-hidden="true">·</span>
              <span className="min-w-0 truncate">{who}</span>
              <span aria-hidden="true">·</span>
              <span className="whitespace-nowrap">{dateLabel}</span>
            </>
          )}
        </p>
      </div>
      {!deleting ? (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("menu", { name: file.name })}
              className="grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground transition-[color,transform] duration-150 hover:bg-muted hover:text-foreground active:scale-[0.97] sm:size-9"
            >
              <MoreHorizontal aria-hidden="true" strokeWidth={1.75} className="size-5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {inline ? (
              <DropdownMenuItem asChild>
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {t("open")}
                </a>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem asChild>
              <a href={download}>{t("download")}</a>
            </DropdownMenuItem>
            {file.can_delete ? <DropdownMenuItem onSelect={onDelete}>{t("delete")}</DropdownMenuItem> : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
