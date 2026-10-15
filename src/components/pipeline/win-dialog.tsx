"use client";

import { useId, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, phoneSheet } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { fulfilments, type DealCard, type Fulfilment } from "@/lib/deals";
import { moneyInputText, parseMoney, toCents } from "@/lib/money";
import { useModKey } from "@/lib/use-platform";
import { cn } from "@/lib/utils";

// "Mark {lead} as won?" (Day 5 design 7.6): the final value (required, above €0, prefilled, focused when empty) and how
// it ships (required: Warehouse inventory or Supplier Stock, two large options). Mark as won (Cmd/Ctrl+Enter) and Cancel
// (Esc). A bottom sheet on phones. Cancel after a drop is a drag cancel: the card springs back.
export function WinDialog({
  card,
  onConfirm,
  onCancel,
}: {
  card: DealCard | null;
  onConfirm: (value: string, fulfilment: Fulfilment) => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={!!card} onOpenChange={(open) => (open ? null : onCancel())}>
      {card ? <WinForm key={card.id} card={card} onConfirm={onConfirm} onCancel={onCancel} /> : null}
    </Dialog>
  );
}

function WinForm({ card, onConfirm, onCancel }: { card: DealCard; onConfirm: (value: string, fulfilment: Fulfilment) => void; onCancel: () => void }) {
  const t = useTranslations("Deals.win");
  const tF = useTranslations("Fulfilment");
  const locale = useLocale();
  const mod = useModKey() ?? "Ctrl";
  const id = useId();
  const valueRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(() => moneyInputText(card.value, locale));
  const [ships, setShips] = useState<Fulfilment | null>(card.fulfilment);
  const [tried, setTried] = useState(false);
  const parsed = parseMoney(text, locale);
  const valueOk = parsed !== null && toCents(parsed) > BigInt(0);
  const submit = () => {
    setTried(true);
    if (!valueOk) return valueRef.current?.focus();
    if (!ships) return document.getElementById(`${id}-ships`)?.querySelector<HTMLElement>("button")?.focus();
    onConfirm(parsed!, ships);
  };
  return (
    <DialogContent
      className={cn(phoneSheet, "sm:w-[min(480px,calc(100%-32px))]")}
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        (valueOk ? document.getElementById(`${id}-ships`)?.querySelector<HTMLElement>("[aria-checked=true],button") : valueRef.current)?.focus();
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
          <DialogDescription className="text-sm text-muted-foreground">{t("body")}</DialogDescription>
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor={`${id}-value`} className="text-sm font-bold">
            {t("value")}
          </label>
          <Input
            ref={valueRef}
            id={`${id}-value`}
            name="value"
            inputMode="decimal"
            autoComplete="off"
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-invalid={tried && !valueOk ? true : undefined}
            aria-describedby={`${id}-value-error`}
            className="font-mono"
          />
          <p id={`${id}-value-error`} className="min-h-5 text-sm text-status-red">
            {tried && !valueOk ? t("valueRequired") : null}
          </p>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-bold">{t("ships")}</legend>
          <div id={`${id}-ships`} role="radiogroup" aria-describedby={`${id}-ships-error`} className="grid gap-2 sm:grid-cols-2">
            {fulfilments.map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={ships === f}
                onClick={() => setShips(f)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowUp") {
                    e.preventDefault();
                    const other = fulfilments.find((x) => x !== f)!;
                    setShips(other);
                    (e.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-ships="${other}"]`))?.focus();
                  }
                }}
                data-ships={f}
                tabIndex={ships === f || (ships === null && f === fulfilments[0]) ? 0 : -1}
                className={cn(
                  "flex min-h-[72px] flex-col items-start gap-1 rounded-md border p-3 text-left transition-[background-color,border-color,scale] duration-150 active:scale-[0.98]",
                  ships === f ? "border-foreground bg-muted" : "border-border hover:bg-muted/60",
                )}
              >
                <span className="text-sm font-bold">{tF(`${f}.title`)}</span>
                <span className="text-xs text-muted-foreground">{tF(`${f}.body`)}</span>
              </button>
            ))}
          </div>
          <p id={`${id}-ships-error`} className="min-h-5 text-sm text-status-red">
            {tried && !ships ? t("shipsRequired") : null}
          </p>
        </fieldset>
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
