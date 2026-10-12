"use client";

import { useId, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, phoneSheet } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { LOST_NOTE_COUNTER_FROM, LOST_NOTE_MAX, UNSAFE_NOTE, lostReasons, type DealCard, type LostReason } from "@/lib/deals";
import { useModKey } from "@/lib/use-platform";
import { cn } from "@/lib/utils";

// "Why was {lead} lost?" (Day 5 design 7.6): the eight reasons as a radio group, a note (required for Other; the counter
// shows from 450 of 500), Mark as lost (Cmd/Ctrl+Enter). Cancel after a drop on the Lost band springs the card back.
export function LoseDialog({ card, onConfirm, onCancel }: { card: DealCard | null; onConfirm: (reason: LostReason, note: string | null) => void; onCancel: () => void }) {
  return (
    <Dialog open={!!card} onOpenChange={(open) => (open ? null : onCancel())}>
      {card ? <LoseForm key={card.id} card={card} onConfirm={onConfirm} onCancel={onCancel} /> : null}
    </Dialog>
  );
}

function LoseForm({ card, onConfirm, onCancel }: { card: DealCard; onConfirm: (reason: LostReason, note: string | null) => void; onCancel: () => void }) {
  const t = useTranslations("Deals.lose");
  const tR = useTranslations("LostReasons");
  const tErr = useTranslations("Errors.hint");
  const format = useFormatter();
  const mod = useModKey() ?? "Ctrl";
  const id = useId();
  const groupRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [reason, setReason] = useState<LostReason | null>(null);
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);
  const length = Array.from(note.trim()).length;
  const noteBad = length > LOST_NOTE_MAX || UNSAFE_NOTE.test(note);
  const needNote = reason === "other" && length === 0;
  const submit = () => {
    setTried(true);
    if (!reason) return groupRef.current?.querySelector<HTMLElement>("[role=radio]")?.focus();
    if (needNote || noteBad) return noteRef.current?.focus();
    onConfirm(reason, note.trim() ? note.trim() : null);
  };
  const focusReason = (r: LostReason) => groupRef.current?.querySelector<HTMLElement>(`[data-reason="${r}"]`)?.focus();
  return (
    <DialogContent
      className={cn(phoneSheet, "max-h-[calc(100dvh-24px)] overflow-y-auto sm:w-[min(520px,calc(100%-32px))]")}
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        groupRef.current?.querySelector<HTMLElement>("[role=radio]")?.focus();
      }}
    >
      <form
        noValidate
        className="flex flex-col gap-5 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
      >
        <div className="flex flex-col gap-1.5">
          <DialogTitle className="text-xl font-bold tracking-[-0.03em] text-balance break-words">{t("title", { lead: card.company_name })}</DialogTitle>
          <DialogDescription className="sr-only">{t("reasons")}</DialogDescription>
        </div>
        <div className="flex flex-col gap-2">
          <span id={`${id}-reasons`} className="text-sm font-bold">
            {t("reasons")}
          </span>
          <div ref={groupRef} role="radiogroup" aria-labelledby={`${id}-reasons`} aria-describedby={`${id}-reason-error`} className="grid gap-1.5 sm:grid-cols-2">
            {lostReasons.map((r, i) => (
              <button
                key={r}
                type="button"
                role="radio"
                data-reason={r}
                aria-checked={reason === r}
                tabIndex={reason === r || (reason === null && i === 0) ? 0 : -1}
                onClick={() => setReason(r)}
                onKeyDown={(e) => {
                  const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
                  if (!step) return;
                  e.preventDefault();
                  const next = lostReasons[(i + step + lostReasons.length) % lostReasons.length];
                  setReason(next);
                  focusReason(next);
                }}
                className={cn(
                  "flex min-h-11 items-center gap-2 rounded-md border px-3 text-left text-sm transition-[background-color,border-color,transform] duration-150 active:scale-[0.98]",
                  reason === r ? "border-foreground bg-muted font-bold" : "border-border hover:bg-muted/60",
                )}
              >
                <span aria-hidden="true" className={cn("grid size-4 shrink-0 place-items-center rounded-full border", reason === r ? "border-foreground" : "border-muted-foreground")}>
                  {reason === r ? <span className="size-2 rounded-full bg-foreground" /> : null}
                </span>
                {tR(r)}
              </button>
            ))}
          </div>
          <p id={`${id}-reason-error`} className="min-h-5 text-sm text-status-red">
            {tried && !reason ? tErr("lost_reason_required") : null}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor={`${id}-note`} className="text-sm font-bold">
            {reason === "other" ? t("note") : t("noteOptional")}
          </label>
          <Textarea
            ref={noteRef}
            id={`${id}-note`}
            name="note"
            dir="auto"
            value={note}
            maxRows={6}
            onChange={(e) => setNote(e.target.value)}
            aria-invalid={tried && (needNote || noteBad) ? true : undefined}
            aria-describedby={`${id}-note-help`}
            className="min-h-20 text-sm"
          />
          <p id={`${id}-note-help`} className="flex min-h-5 justify-between gap-3 text-sm">
            <span className="text-status-red">{tried && needNote ? t("noteRequired") : tried && noteBad ? tErr("lost_note") : null}</span>
            {length >= LOST_NOTE_COUNTER_FROM ? (
              <span className={cn("font-mono tabular-nums", length > LOST_NOTE_MAX ? "text-status-red" : "text-muted-foreground")}>
                {t("noteCount", { count: format.number(length) })}
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button variant="quiet" onClick={onCancel}>
            {t("cancel")}
          </Button>
          <Button type="submit" variant="neutral">
            {t("submit")}
            <span className="ml-1 hidden gap-1 sm:inline-flex" aria-hidden="true">
              <Kbd className="border-transparent bg-primary-foreground/15 text-primary-foreground">{mod}</Kbd>
              <Kbd className="border-transparent bg-primary-foreground/15 text-primary-foreground">↩</Kbd>
            </span>
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}
