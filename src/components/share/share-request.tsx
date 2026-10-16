"use client";

import { useId, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Minus, Plus, X } from "lucide-react";
import { usePrice } from "@/components/share/share-list";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, phoneSheet } from "@/components/ui/dialog";
import type { ShareItem } from "@/lib/share/schema";
import { cn } from "@/lib/utils";

// The client's request (design 10.5): a sheet per product (quantity in pieces or cartons, "= 2 cartons", more than
// available allowed with a note), then the review sheet (lines, free text, an optional name, the honeypot) and Send.

export type BasketLine = { item: ShareItem; quantity: number; unit: "piece" | "carton" };

const MAX_QTY = 10_000_000;

export function ItemSheet({
  item,
  initial,
  onClose,
  onSave,
  returnFocusTo,
}: {
  item: ShareItem | null;
  initial: BasketLine | null;
  onClose: () => void;
  onSave: (line: BasketLine) => void;
  /** Where the focus goes when the sheet closes (the product's row; never the page). */
  returnFocusTo: () => HTMLElement | null;
}) {
  const t = useTranslations("Share.item");
  const ts = useTranslations("Share");
  const format = useFormatter();
  const price = usePrice();
  const id = useId();
  const [unit, setUnit] = useState<"piece" | "carton">(initial?.unit ?? "piece");
  const [text, setText] = useState(initial ? String(initial.quantity) : "");
  const [openFor, setOpenFor] = useState<number | null>(null);
  if (item && openFor !== item.number) {
    setOpenFor(item.number);
    setUnit(initial?.unit ?? "piece");
    setText(initial ? String(initial.quantity) : "");
  }
  if (!item && openFor !== null) setOpenFor(null);
  const qty = /^\d{1,8}$/.test(text.trim()) ? Number(text.trim()) : null;
  const valid = qty !== null && qty >= 1 && qty <= MAX_QTY;
  const ppc = item?.piecesPerCarton ?? 1;
  const piecesAsked = valid ? qty * (unit === "carton" ? ppc : 1) : 0;
  const avail = item ? (item.warehouse > 0 ? item.warehouse : item.transit) : 0;
  const step = (d: number) => setText(String(Math.min(MAX_QTY, Math.max(1, (qty ?? 0) + d))));
  return (
    <Dialog open={!!item} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        aria-describedby={`${id}-desc`}
        onCloseAutoFocus={(e) => {
          const target = returnFocusTo();
          if (target) {
            e.preventDefault();
            target.focus();
          }
        }}
        className={cn(phoneSheet, "max-h-[calc(100dvh-24px)] overflow-y-auto overscroll-contain sm:w-[min(480px,calc(100%-32px))]")}
      >
        {item ? (
          <form noValidate
            className="flex flex-col gap-5 p-5 sm:p-6"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) onSave({ item, quantity: qty, unit });
            }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-1">
                <DialogTitle className="text-xl font-bold text-balance break-words" translate="no">
                  {item.name}
                </DialogTitle>
                <DialogDescription id={`${id}-desc`} className="flex flex-wrap gap-x-2 font-mono text-sm text-muted-foreground tabular-nums">
                  <span className="whitespace-nowrap">
                    {item.priceMax === null ? ts("priceOnRequest") : `${price(item.priceMax)} ${ts("perPiece")}`}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="whitespace-nowrap">
                    {ts("availability", { pieces: format.number(avail), cartons: Math.floor(avail / ppc), ppc: format.number(ppc) })}
                  </span>
                </DialogDescription>
              </div>
              <button type="button" onClick={onClose} aria-label={t("close")} className="-mt-2 -mr-2 grid size-11 shrink-0 place-items-center rounded-full hover:bg-muted">
                <X aria-hidden="true" strokeWidth={1.75} className="size-5" />
              </button>
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor={`${id}-qty`} className="text-sm font-bold">
                {t("quantity")}
              </label>
              <div className="flex items-stretch gap-2">
                <button type="button" onClick={() => step(-1)} aria-label={t("less")} className="grid size-11 shrink-0 place-items-center rounded-md bg-muted">
                  <Minus aria-hidden="true" strokeWidth={2} className="size-4" />
                </button>
                <input
                  id={`${id}-qty`}
                  name="quantity"
                  inputMode="numeric"
                  autoComplete="off"
                  value={text}
                  onChange={(e) => setText(e.target.value.replace(/[^\d]/g, "").slice(0, 8))}
                  aria-invalid={text !== "" && !valid ? true : undefined}
                  aria-describedby={`${id}-qty-hint`}
                  className="min-h-11 w-full min-w-0 rounded-md border border-border bg-background px-3 text-right font-mono text-base tabular-nums"
                />
                <button type="button" onClick={() => step(1)} aria-label={t("more")} className="grid size-11 shrink-0 place-items-center rounded-md bg-muted">
                  <Plus aria-hidden="true" strokeWidth={2} className="size-4" />
                </button>
                <div role="radiogroup" aria-label={t("unit")} className="grid shrink-0 grid-cols-2 rounded-md bg-muted p-1">
                  {(["piece", "carton"] as const).map((u) => (
                    <button
                      key={u}
                      type="button"
                      role="radio"
                      aria-checked={unit === u}
                      onClick={() => setUnit(u)}
                      className={cn("min-h-11 min-w-11 rounded-[10px] px-2 font-mono text-sm sm:min-h-9", unit === u && "bg-card shadow-sm")}
                    >
                      {u === "piece" ? t("pcs") : t("ctn")}
                    </button>
                  ))}
                </div>
              </div>
              <p id={`${id}-qty-hint`} className="min-h-5 font-mono text-xs text-muted-foreground" aria-live="polite">
                {text !== "" && !valid
                  ? t("wholeNumber")
                  : valid
                    ? unit === "carton"
                      ? t("equals", { pieces: format.number(piecesAsked) })
                      : Number.isInteger(piecesAsked / ppc) && piecesAsked >= ppc
                        ? t("equalsCartons", { count: piecesAsked / ppc })
                        : ""
                    : ""}
              </p>
              {valid && piecesAsked > avail ? <p className="text-sm">{t("moreThanAvailable", { pieces: format.number(avail) })}</p> : null}
            </div>
            <Button type="submit" variant="neutral" aria-disabled={!valid || undefined}>
              {initial ? t("update") : t("add")}
            </Button>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export type SendState = { kind: "idle" } | { kind: "sending" } | { kind: "error"; text: string };

export function ReviewSheet({
  open,
  onOpenChange,
  lines,
  note,
  onNote,
  name,
  onName,
  onEdit,
  onRemove,
  onSend,
  state,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  lines: BasketLine[];
  note: string;
  onNote: (v: string) => void;
  name: string;
  onName: (v: string) => void;
  onEdit: (line: BasketLine) => void;
  onRemove: (number: number) => void;
  onSend: (website: string) => void;
  state: SendState;
}) {
  const t = useTranslations("Share.basket");
  const ti = useTranslations("Share.item");
  const format = useFormatter();
  const id = useId();
  const honeypot = useRef<HTMLInputElement>(null);
  const [missing, setMissing] = useState(false);
  const used = [...note].length;
  const ready = lines.length > 0 || [...note.trim()].length >= 3;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (state.kind === "sending") return;
        if (!o) setMissing(false);
        onOpenChange(o);
      }}
    >
      <DialogContent aria-describedby={`${id}-desc`} className={cn(phoneSheet, "max-h-[calc(100dvh-24px)] overflow-y-auto overscroll-contain sm:w-[min(560px,calc(100%-32px))]")}>
        <form noValidate
          className="flex flex-col gap-5 p-5 sm:p-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (state.kind === "sending") return;
            if (!ready) {
              setMissing(true);
              document.getElementById(`${id}-note`)?.focus();
              return;
            }
            onSend(honeypot.current?.value ?? "");
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <DialogTitle className="text-xl font-bold">{t("title")}</DialogTitle>
              <DialogDescription id={`${id}-desc`} className="text-sm text-muted-foreground">
                {t("body")}
              </DialogDescription>
            </div>
            <button type="button" onClick={() => onOpenChange(false)} aria-label={ti("close")} className="-mt-2 -mr-2 grid size-11 shrink-0 place-items-center rounded-full hover:bg-muted">
              <X aria-hidden="true" strokeWidth={1.75} className="size-5" />
            </button>
          </div>
          {lines.length === 0 ? (
            <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
              {lines.map((l) => (
                <li key={l.item.number} className="flex min-h-14 items-center gap-2 py-1 pr-1 pl-3">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-bold" translate="no">
                      {l.item.name}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground tabular-nums">
                      {t("line", { quantity: format.number(l.quantity), unit: l.unit === "carton" ? ti("ctn") : ti("pcs") })}
                    </span>
                  </span>
                  <Button type="button" variant="link" className="px-2" onClick={() => onEdit(l)} aria-label={t("edit", { name: l.item.name })}>
                    {t("change")}
                  </Button>
                  <button type="button" onClick={() => onRemove(l.item.number)} aria-label={t("remove", { name: l.item.name })} className="grid size-11 place-items-center rounded-full hover:bg-muted">
                    <X aria-hidden="true" strokeWidth={1.75} className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3">
              <label htmlFor={`${id}-note`} className="text-sm font-bold">
                {t("other")}
              </label>
              {/* The counter sits on the label's line, so the empty slot adds no gap under the field. */}
              <p id={`${id}-note-count`} className="font-mono text-xs text-muted-foreground tabular-nums" aria-live="polite">
                {used >= 900 ? t("counter", { used }) : ""}
              </p>
            </div>
            <textarea
              id={`${id}-note`}
              name="note"
              rows={3}
              maxLength={1000}
              value={note}
              onChange={(e) => onNote(e.target.value)}
              placeholder={t("otherPlaceholder")}
              aria-describedby={`${id}-note-count`}
              className="rounded-md border border-border bg-background px-3 py-2 text-base"
            />
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor={`${id}-name`} className="text-sm font-bold">
              {t("name")}
            </label>
            <input
              id={`${id}-name`}
              name="name"
              autoComplete="name"
              maxLength={80}
              value={name}
              onChange={(e) => onName(e.target.value)}
              className="min-h-11 rounded-md border border-border bg-background px-3 text-base"
            />
          </div>
          {/* The honeypot: hidden from people and screen readers; a bot that fills it gets a polite "received". */}
          <div aria-hidden="true" className="absolute -left-[10000px] h-px w-px overflow-hidden">
            <label htmlFor={`${id}-website`}>{t("honeypot")}</label>
            <input id={`${id}-website`} ref={honeypot} name="website" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
          </div>
          <div className="flex flex-col items-stretch gap-1 sm:items-end">
            <Button type="submit" variant="brand" aria-disabled={state.kind === "sending" || undefined} aria-describedby={`${id}-why`}>
              {state.kind === "sending" ? t("sending") : t("send")}
            </Button>
            <p id={`${id}-why`} role={state.kind === "error" ? "alert" : undefined} className="min-h-5 text-sm" aria-live="polite">
              {state.kind === "error" ? state.text : missing && !ready ? t("needSomething") : ""}
            </p>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
