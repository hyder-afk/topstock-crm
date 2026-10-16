"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
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
import { cleanFileName, splitName } from "@/lib/files/name";
import { fileDateLabel } from "@/lib/files/dates";
import { canRetry, checkLocalFile, failureToUpload, uploadBytes, type UploadError } from "@/lib/files/upload";
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
// why on its own line, and the polite status line says it too (with the reason). A failure that is not the file's fault
// (connection, Storage, the check after upload, more than 5 at once) offers Try again on the same file. No pending row is
// ever left behind without a line: when the check after upload cannot read the bytes, the upload is cancelled at once
// (and the line keeps the id to cancel again on Dismiss if that call failed). Focus never drops to the page: when a
// line's button changes (Cancel, then nothing while checking, then Try again or Dismiss), it moves to the line's new
// button or the line itself; the Delete dialog (Escape, Cancel, a cancelled code, a failed delete) closes back onto the
// row's Actions, its Retry once stuck deleting, or the heading when the row is gone. While the tab is hidden (another tab selected), outcomes also show as a toast, and a file
// dropped outside the zone is ignored instead of replacing the page. Rows link with plain <a> to /api/files/<id>, never Next Link, so hovering never prefetches, and
// the 60-second link to the bytes exists only in that route's redirect.

type StepUp = { ensureFresh: (minSeconds?: number, focusFallback?: () => HTMLElement | null) => Promise<boolean>; requireFresh: () => Promise<boolean> };
type Upload = {
  key: number;
  name: string;
  size: number;
  mime: FileMime | null;
  phase: "uploading" | "checking" | "error";
  progress: number;
  error?: UploadError;
  controller: AbortController;
  /** The chosen file, kept for Try again. */
  file: File;
  /** A pending row the browser could not cancel (abortUpload failed): Dismiss and Try again cancel it first. */
  pendingId?: string;
};
type FocusAfter = { key: number } | "choose" | null;

const rowEl = (key: number) => document.querySelector<HTMLElement>(`[data-upload-key="${key}"]`);
const rowHasFocus = (key: number) => {
  const el = rowEl(key);
  return !!el && el.contains(document.activeElement);
};

const kindIcon: Record<FileKind, typeof FileText> = { pdf: FileText, image: ImageIcon, word: FileType2, excel: FileSpreadsheet };

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
  const zoneRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const seq = useRef(0);
  // Whether the tab is shown: React's Activity runs a hidden tab's effect clean-ups, so this is true only while it is.
  const shown = useRef(false);
  const focusAfter = useRef<FocusAfter>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [over, setOver] = useState(false);
  // The polite status line holds the last few messages as separate nodes, so several outcomes in one render (five
  // refused files, the "up to 5 at a time" summary) are each read out, not only the last one.
  const [said, setSaid] = useState<{ id: number; text: string }[]>([]);
  const saidSeq = useRef(0);
  const [confirm, setConfirm] = useState<LeadFile | null>(null);
  // The file whose Delete was chosen: its menu item is gone when the dialog closes, so the focus goes back to the row's
  // own button (Actions, or Retry once it is stuck deleting) or, when the row is gone, the heading (round 3 finding 1).
  const returnTo = useRef<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

  const rows = files.data?.pages.flatMap((p) => p.files) ?? [];
  const usage = files.data?.pages[0]?.usage ?? null;

  // A phase change swaps the line's button (Cancel, nothing, Try again or Dismiss): if the focus was in that line, it
  // moves after the commit to the line's new button, or to the line itself while checking (verifier 4d round 2
  // findings 8 and 13).
  const patch = useCallback((key: number, change: Partial<Upload>) => {
    if (change.phase && rowHasFocus(key)) focusAfter.current = { key };
    setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...change } : u)));
  }, []);
  // An item leaving the list takes its focused button with it: the focus goes to "Choose files" instead of the page.
  const drop = useCallback((key: number) => {
    if (rowHasFocus(key)) focusAfter.current = "choose";
    setUploads((list) => list.filter((u) => u.key !== key));
  }, []);
  useEffect(() => {
    const target = focusAfter.current;
    if (!target) return;
    focusAfter.current = null;
    if (target === "choose") return chooseRef.current?.focus();
    const el = rowEl(target.key);
    const active = document.activeElement;
    if (!el || (active && active !== el && el.contains(active))) return;
    (el.querySelector<HTMLElement>("[data-upload-action]") ?? el).focus();
  }, [uploads]);

  // While the tab is shown: a file dropped anywhere but the zone is refused (no "open the PDF in this tab", which
  // would leave the lead page; verifier 4d round 2 finding 17). Removed while another tab is selected.
  useEffect(() => {
    shown.current = true;
    const guard = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      if (e.target instanceof Node && zoneRef.current?.contains(e.target)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "none";
    };
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    return () => {
      shown.current = false;
      window.removeEventListener("dragover", guard);
      window.removeEventListener("drop", guard);
    };
  }, []);

  /** A final outcome: the polite status line, and a toast as well while the tab is hidden (its status line is then out of
   *  the accessibility tree and its lines out of sight; verifier 4d round 2 finding 18). The lines stay for when the tab
   *  is opened again. */
  const say = useCallback((text: string) => {
    saidSeq.current += 1;
    const id = saidSeq.current;
    setSaid((list) => [...list.slice(-(FILES_PER_DROP * 2 - 1)), { id, text }]);
  }, []);
  const tell = useCallback(
    (message: string) => {
      say(message);
      if (!shown.current) toast.show(message);
    },
    [say, toast],
  );
  const errorText = useCallback(
    (error: UploadError, mime: FileMime | null) => (error === "mismatch" && mime ? t(`errors.mismatch.${fileKind(mime)}`) : t(`errors.${error}`)),
    [t],
  );

  /** One file, start to end, on its own line (a new line, or the same line again for Try again). */
  const uploadOne = useCallback(
    async (file: File, again?: { key: number; pendingId?: string }) => {
      let key: number;
      const controller = new AbortController();
      if (again) {
        key = again.key;
        if (again.pendingId) await abortUpload({ id: again.pendingId }).catch(() => null);
        patch(key, { phase: "uploading", progress: 0, error: undefined, mime: null, controller, pendingId: undefined });
      } else {
        seq.current += 1;
        key = seq.current;
        setUploads((list) => [...list, { key, name: file.name, size: file.size, mime: null, phase: "uploading", progress: 0, controller, file }]);
      }
      let mime: FileMime | null = null;
      const fail = (error: UploadError, pendingId?: string) => {
        patch(key, { phase: "error", error, mime, pendingId });
        tell(t("announce.failed", { name: file.name, reason: errorText(error, mime) }));
      };
      // Cancels a pending row; when that fails too, the line keeps the id (Dismiss and Try again cancel it).
      const cancel = async (id: string) => ((await abortUpload({ id }).catch(() => null))?.ok ? undefined : id);
      const local = await checkLocalFile(file);
      if (!local.ok) {
        if (local.reason === "mismatch") mime = local.mime;
        return fail(local.reason);
      }
      mime = local.mime;
      patch(key, { mime });
      // The cleaned name (at most 180 characters), as the server would store it: a real file with a very long name is
      // not refused for it (verifier 4d round 3 finding 2). The server cleans it again.
      const begun = await beginUpload({ leadId, name: cleanFileName(file.name, mime), mime, size: file.size }).catch(() => null);
      if (!begun) return fail("connection");
      if (!begun.ok) return fail(failureToUpload(begun));
      say(t("announce.uploading", { name: begun.data.name }));
      const { data } = await createClient().auth.getSession();
      const token = data.session?.access_token;
      if (!token) return fail("unavailable", await cancel(begun.data.id));
      const outcome = await uploadBytes({
        supabaseUrl: publicEnv.NEXT_PUBLIC_SUPABASE_URL,
        anonKey: publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        token,
        path: begun.data.path,
        file,
        mime,
        onProgress: (progress) => patch(key, { progress }),
        signal: controller.signal,
      });
      if (outcome !== "done") {
        const left = await cancel(begun.data.id);
        if (outcome === "cancelled") {
          say(t("announce.cancelled", { name: begun.data.name }));
          if (left) return fail("unavailable", left);
          return drop(key);
        }
        return fail(outcome === "failed" ? "connection" : "unavailable", left);
      }
      patch(key, { phase: "checking", progress: 1 });
      say(t("checking"));
      const finished = await finishUpload({ id: begun.data.id }).catch(() => null);
      if (!finished || !finished.ok) {
        const error = finished ? failureToUpload(finished) : "connection";
        // The bytes could not be read back ("unavailable", the row kept pending) or the answer was lost: cancel the
        // pending row now rather than leave it, unseen, holding one of the 5 waiting places and the team's space until
        // the 15-minute clean-up (verifier 4d round 2 finding 7). A refused file was already removed by the server.
        const left = error === "mismatch" ? undefined : await cancel(begun.data.id);
        if (!finished) void queryClient.invalidateQueries({ queryKey: filesKey(leadId) });
        return fail(error, left);
      }
      await queryClient.invalidateQueries({ queryKey: filesKey(leadId) });
      tell(t("announce.added", { name: finished.data.name }));
      drop(key);
    },
    [leadId, patch, drop, queryClient, t, say, tell, errorText],
  );

  // Up to 5 files at a time, one after the other (the server runs one action at a time per tab anyway).
  const take = useCallback(
    async (list: FileList | null) => {
      if (!list || list.length === 0) return;
      const chosen = Array.from(list);
      const extras = chosen.slice(FILES_PER_DROP);
      for (const extra of extras) {
        seq.current += 1;
        const key = seq.current;
        setUploads((u) => [...u, { key, name: extra.name, size: extra.size, mime: null, phase: "error", progress: 0, error: "tooMany", controller: new AbortController(), file: extra }]);
      }
      // Said once for all of them, before the first upload's own lines (verifier 4d round 2 finding 14).
      if (extras.length > 0) tell(t("announce.tooMany", { count: extras.length }));
      for (const file of chosen.slice(0, FILES_PER_DROP)) await uploadOne(file);
    },
    [uploadOne, tell, t],
  );

  const retry = (u: Upload) => void uploadOne(u.file, { key: u.key, pendingId: u.pendingId });
  const dismiss = (u: Upload) => {
    if (u.pendingId) void abortUpload({ id: u.pendingId }).catch(() => null);
    drop(u.key);
  };

  // "Show older files" stays one button (it becomes Try again under the error), so it keeps the focus while it loads or
  // fails; when the last page arrives and it goes, the focus moves to the first file that arrived, or to the heading
  // when that page came back empty (the older files were deleted meanwhile) (verifier 4d round 2 finding 10). It settles
  // in the commit that ends the fetch: waiting two frames after the fetch raced the render, so the button could still
  // hold the focus at the check and then leave with it (WebKit e2e, PR #17). An error or a cancelled fetch keeps the
  // button (or Try again), so the focus stays where it is.
  const olderFrom = useRef<number | null>(null);
  const loadOlder = () => {
    if (files.isFetchingNextPage) return;
    olderFrom.current = rows.length;
    void files.fetchNextPage();
  };
  useLayoutEffect(() => {
    const before = olderFrom.current;
    if (before === null || files.isFetchingNextPage) return;
    olderFrom.current = null;
    if (document.activeElement && document.activeElement !== document.body) return;
    const first = rows.length > before && !files.hasNextPage ? listRef.current?.children[before]?.querySelector<HTMLElement>("a, button") : null;
    (first ?? headingRef.current)?.focus();
  }, [rows.length, files.hasNextPage, files.isFetchingNextPage]);

  /** The row's own button (Actions, or Retry while stuck deleting) for a file still listed, else the heading. */
  const rowTarget = useCallback(
    (id: string | null): HTMLElement | null => {
      const listed = !!id && !!queryClient.getQueryData<InfiniteData<FilesPage>>(filesKey(leadId))?.pages.some((p) => p.files.some((f) => f.id === id));
      const el = listed ? listRef.current?.querySelector<HTMLElement>(`[data-file-actions="${CSS.escape(id)}"]`) : null;
      return el ?? headingRef.current;
    },
    [queryClient, leadId],
  );
  /** Puts the focus on the row (or the heading) only when nothing has it, so a focus the person moved is never taken. */
  const refocusRow = useCallback(
    (id: string | null) => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      rowTarget(id)?.focus();
    },
    [rowTarget],
  );

  const remove = async (file: LeadFile) => {
    returnTo.current = file.id;
    setConfirm(null);
    if (file.status === "ready" && !(await stepUp.ensureFresh(60, () => rowTarget(file.id)))) return;
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
      // The refetch may have swapped the row's menu for Retry (stuck deleting) or removed the row: the focus goes to
      // what the row has now, never to the page.
      requestAnimationFrame(() => requestAnimationFrame(() => refocusRow(file.id)));
      return;
    }
    queryClient.setQueryData<InfiniteData<FilesPage>>(filesKey(leadId), (old) =>
      old ? { ...old, pages: old.pages.map((p) => ({ ...p, files: p.files.filter((f) => f.id !== file.id) })) } : old,
    );
    void queryClient.invalidateQueries({ queryKey: filesKey(leadId) });
    toast.show(t("deleted", { name: file.name }));
    requestAnimationFrame(() => headingRef.current?.focus());
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

      {/* The drop zone: a real button inside, so it works without a mouse; dropping is an extra. The file input itself is
          hidden from assistive technology and the keyboard: the visible button, described by the limits, is the control. */}
      <div
        ref={zoneRef}
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
          aria-hidden="true"
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

      <div className="sr-only" role="status" aria-live="polite">
        {said.map((m) => (
          <p key={m.id}>{m.text}</p>
        ))}
      </div>

      {uploads.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label={t("uploadsLabel")}>
          {uploads.map((u) => (
            <li
              key={u.key}
              data-upload-key={u.key}
              tabIndex={-1}
              className="flex min-w-0 flex-col gap-2 rounded-md border border-border bg-card p-3"
            >
              <div className="flex min-w-0 items-center gap-3">
                <FileName name={u.name} className="flex-1 font-bold" />
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{size(u.size)}</span>
                {u.phase === "uploading" ? (
                  <Button data-upload-action variant="link" className="min-h-11 shrink-0 text-sm sm:min-h-9" onClick={() => u.controller.abort()}>
                    {t("cancel")}
                  </Button>
                ) : u.phase === "error" ? (
                  <div className="flex shrink-0 items-center gap-1">
                    {canRetry(u.error) ? (
                      <Button
                        data-upload-action
                        variant="link"
                        aria-label={t("retryUpload", { name: u.name })}
                        className="min-h-11 px-2 text-sm font-bold text-foreground sm:min-h-9"
                        onClick={() => retry(u)}
                      >
                        {t("retry")}
                      </Button>
                    ) : null}
                    <button
                      type="button"
                      {...(canRetry(u.error) ? {} : { "data-upload-action": true })}
                      aria-label={t("dismiss", { name: u.name })}
                      onClick={() => dismiss(u)}
                      className="grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground transition-[color,transform] duration-150 hover:text-foreground active:scale-[0.97] sm:size-9"
                    >
                      <X aria-hidden="true" strokeWidth={1.75} className="size-4" />
                    </button>
                  </div>
                ) : null}
              </div>
              {u.phase === "error" ? (
                <p className="flex items-start gap-2 text-sm">
                  <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-status-red" />
                  <span>{errorText(u.error ?? "unavailable", u.mime)}</span>
                </p>
              ) : (
                <div className="flex flex-col gap-1">
                  {/* The track is the muted surface on the card-coloured line (DESIGN.md: tracks), so its length shows in
                      both themes and 30% reads as 30% (verifier 4d round 2 finding 15). */}
                  <div
                    role="progressbar"
                    aria-label={t("progressLabel", { name: u.name })}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(u.progress * 100)}
                    aria-valuetext={u.phase === "checking" ? t("checking") : format.number(u.progress, { style: "percent", maximumFractionDigits: 0 })}
                    className="h-2 overflow-hidden rounded-full bg-muted"
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
        <ul ref={listRef} aria-labelledby={`${inputId}-title`} className="-mx-1 flex flex-col">
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
                  dateLabel={fileDateLabel(format, now, f.created_at)}
                  busy={busyIds.has(f.id)}
                  onDelete={() => {
                    returnTo.current = f.id;
                    if (f.status === "deleting") void remove(f);
                    else setConfirm(f);
                  }}
                />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      {files.isFetchingNextPage ? (
        <ul aria-hidden="true" className="flex flex-col gap-2">
          {Array.from({ length: 2 }, (_, i) => (
            <li key={i} className="flex min-h-14 items-center gap-3">
              <div className="size-11 shrink-0 rounded-md bg-muted motion-safe:animate-pulse" />
              <div className="flex flex-1 flex-col gap-1.5">
                <div className="h-5 w-2/3 max-w-72 rounded-sm bg-muted motion-safe:animate-pulse" />
                <div className="h-4 w-1/2 max-w-56 rounded-sm bg-muted motion-safe:animate-pulse" />
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {files.hasNextPage ? (
        <div className="flex flex-col items-start gap-2">
          {files.isFetchNextPageError ? (
            <p role="alert" className="flex items-start gap-2 text-sm">
              <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-status-red" />
              <span>{t("errorOlder")}</span>
            </p>
          ) : null}
          <Button variant="quiet" className="aria-disabled:opacity-60" aria-disabled={files.isFetchingNextPage || undefined} onClick={loadOlder}>
            {files.isFetchNextPageError ? t("retry") : t("loadOlder")}
          </Button>
        </div>
      ) : null}

      <Dialog open={confirm !== null} onOpenChange={(open) => (open ? null : setConfirm(null))}>
        <DialogContent
          className={cn(phoneSheet, "sm:w-[min(440px,calc(100%-32px))]")}
          // Radix would return the focus to the menu item that opened it, which is gone (so to the page): the row's own
          // button instead, unless the next dialog (a new code) already has it.
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            refocusRow(returnTo.current);
          }}
        >
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

/** A name that keeps its end: the stem is cut with an ellipsis, the extension always shows. Read as one name (the two
 *  visible parts are flex items, which screen readers would read with a space between them). */
function FileName({ name, className }: { name: string; className?: string }) {
  const { stem, ext } = splitName(name);
  return (
    <span className={cn("flex min-w-0", className)} translate="no">
      <span className="sr-only">{name}</span>
      <span aria-hidden="true" dir="auto" className="truncate">
        {stem}
      </span>
      <span aria-hidden="true" className="shrink-0">
        {ext}
      </span>
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
    // On phones the name's link covers the whole line (a stretched ::after), so the row is one 44 px+ target; the menu
    // button sits above it (verifier 4d round 2 finding 16).
    <div className="relative flex min-h-14 min-w-0 items-center gap-3 rounded-md px-1 py-1.5 transition-colors duration-150 max-sm:has-[a:active]:bg-muted">
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
            className="flex min-h-6 min-w-0 rounded-sm font-bold underline-offset-4 hover:underline max-sm:after:absolute max-sm:after:inset-0 max-sm:after:rounded-md"
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
              {/* aria-disabled, not disabled: a disabled button drops its focus to the page; the name says which file. */}
              <button
                type="button"
                data-file-actions={file.id}
                onClick={() => (busy ? undefined : onDelete())}
                aria-disabled={busy || undefined}
                aria-label={t("retryDeleteNamed", { name: file.name })}
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-sm font-bold text-foreground underline-offset-4 transition-[opacity,transform] duration-150 hover:underline active:scale-[0.97] aria-disabled:opacity-60 sm:min-h-0 sm:min-w-0"
              >
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
              data-file-actions={file.id}
              aria-label={t("menu", { name: file.name })}
              className="relative grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground transition-[color,transform] duration-150 hover:bg-muted hover:text-foreground active:scale-[0.97] sm:size-9"
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
