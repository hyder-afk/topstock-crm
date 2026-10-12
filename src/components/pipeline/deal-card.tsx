"use client";

import { createContext, memo, useContext, useId, useRef, useState } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useDraggable } from "@dnd-kit/core";
import { motion, useReducedMotion } from "motion/react";
import { MoreHorizontal } from "lucide-react";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { DealMenuItems, type DealMenuActions } from "@/components/pipeline/deal-menu";
import { useShell } from "@/components/shell/keyboard-layer";
import { cardKeyAction, type CardKeyAction } from "@/components/pipeline/use-board-keys";
import { elapsedDays, nextStage, type DealCard as Card } from "@/lib/deals";
import { personName } from "@/lib/leads";
import { formatMoney } from "@/lib/money";
import { springs } from "@/lib/motion";
import { isTyping } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

// One deal on the board (Day 5 design 7.2): li > article, 120 px at 1440 (the column's li carries the neighbours' layout animation; the article carries the settle,
// so the two transforms never meet on one element). A stretched main button holds the visible
// text and is the drag handle (dnd-kit's activator: Space picks it up, Enter opens the deal); the next-step chip and the
// ⋯ menu are sibling buttons above it, so no control sits inside another. Right-click, Shift+F10 or the menu key open
// the same menu. Press feedback is a 0.97 scale within 100 ms; hover is a tint, never a lift. Memoised per card.
export type BoardHandlers = {
  onKey: (card: Card, action: Exclude<CardKeyAction, null>) => void;
  onNext: (card: Card) => void;
  menu: (card: Card) => DealMenuActions;
  onFocusCard: (id: string) => void;
};
export const BoardHandlersContext = createContext<BoardHandlers | null>(null);

function initials(first: string | null, last: string | null) {
  return `${(first ?? "").trim().charAt(0)}${(last ?? "").trim().charAt(0)}`.toUpperCase() || "·";
}

export const DealCardView = memo(function DealCardView({
  card,
  now,
  stallDays,
  showOwner,
  tabStop,
  dim = false,
  disabled = false,
}: {
  card: Card;
  now: number;
  stallDays: number | null;
  showOwner: boolean;
  tabStop: boolean;
  dim?: boolean;
  disabled?: boolean;
}) {
  const t = useTranslations("Deals");
  const tStage = useTranslations("Stages");
  const tAnn = useTranslations("Pipeline.announce");
  const format = useFormatter();
  const locale = useLocale();
  const shell = useShell();
  const handlers = useContext(BoardHandlersContext);
  const [menuOpen, setMenuOpen] = useState(false);
  const domId = useId();
  const lastPointer = useRef<string>("mouse");
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: card.id,
    data: { stage: card.stage, version: card.version },
    disabled: disabled || !card.can_edit || card.stage === "won" || card.stage === "lost",
    attributes: { roleDescription: tAnn("roledescription"), tabIndex: tabStop ? 0 : -1 },
  });

  const owner = personName({ first_name: card.owner_first_name, last_name: card.owner_last_name });
  const days = elapsedDays(card.stage_entered_at, now);
  const next = card.can_edit ? nextStage(card.stage) : null;
  const today = new Date(now).toISOString().slice(0, 10);
  const closePassed = card.status === "open" && card.expected_close !== null && card.expected_close < today;
  const dateShort = (iso: string) => format.dateTime(new Date(iso), { day: "numeric", month: "short" });
  const closeDate = (d: string) => format.dateTime(new Date(`${d}T12:00:00Z`), { day: "numeric", month: "short", timeZone: "UTC" });

  let status: React.ReactNode;
  if (card.stage === "won" && card.closed_at) status = t("wonOn", { date: dateShort(card.closed_at) });
  else if (card.stage === "lost" && card.closed_at) status = t("lostOn", { date: dateShort(card.closed_at) });
  else if (closePassed) status = <span className="text-status-red">{t("closePassed", { date: closeDate(card.expected_close!) })}</span>;
  else {
    status = (
      <>
        {t("daysInStage", { count: days })}
        {card.is_stalled ? (
          <span className="inline-flex items-center gap-1" title={stallDays ? t("stalledHint", { quiet: card.quiet_days ?? days, limit: stallDays, stage: tStage(card.stage) }) : undefined}>
            <span aria-hidden="true">·</span>
            <span aria-hidden="true" className="size-1.5 rounded-full bg-status-amber" />
            <span className="text-status-amber">{t("stalled")}</span>
            {stallDays ? <span className="sr-only">{t("stalledHint", { quiet: card.quiet_days ?? days, limit: stallDays, stage: tStage(card.stage) })}</span> : null}
          </span>
        ) : null}
        {!card.is_stalled && card.expected_close ? <span> · {t("closes", { date: closeDate(card.expected_close) })}</span> : null}
      </>
    );
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const action = cardKeyAction(e, card.stage, {
      typing: isTyping(e.target),
      dialogOpen: !!document.querySelector("[role=dialog]"),
      chordPending: shell.isChordPending(),
    });
    if (action && action.kind === "menu") {
      e.preventDefault();
      setMenuOpen(true);
      return;
    }
    if (action && handlers) {
      e.preventDefault();
      e.stopPropagation();
      handlers.onKey(card, action);
      return;
    }
    listeners?.onKeyDown?.(e);
  };

  const menuActions = handlers?.menu(card);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <motion.article
          ref={setNodeRef}
          data-deal-card={card.id}
          data-stage={card.stage}
          onPointerDownCapture={(e) => (lastPointer.current = e.pointerType)}
          onContextMenu={(e) => {
            // A long press on a phone lifts the card for a drag (TouchSensor): it never opens the menu too.
            if (lastPointer.current === "touch") e.preventDefault();
          }}
          className={cn(
            "group relative min-h-[120px] rounded-lg border border-border bg-card text-left transition-[background-color,opacity] duration-150",
            "hover:bg-[color-mix(in_oklab,var(--card)_94%,var(--foreground))]",
            "has-[[data-deal-main]:active]:scale-[0.97]",
            isDragging && "opacity-40",
            dim && !isDragging && "opacity-60",
          )}
        >
          {/* The main button is stretched over the whole card (the drag handle and "open"): its name is the lead and
              its description the rest of the card, read from the visible text below, which lets clicks through. The
              chip and the ⋯ menu sit in the text's flow as their own buttons (never inside the main button). */}
          <button
            ref={setActivatorNodeRef}
            type="button"
            data-deal-main={card.id}
            {...attributes}
            {...listeners}
            aria-disabled={undefined}
            aria-pressed={undefined}
            aria-labelledby={`${domId}-name`}
            aria-describedby={`${domId}-details ${attributes["aria-describedby"] ?? ""}`.trim()}
            onKeyDown={onKeyDown}
            onFocus={() => handlers?.onFocusCard(card.id)}
            onClick={() => handlers?.onKey(card, { kind: "open" })}
            className="absolute inset-0 z-0 w-full touch-manipulation rounded-lg focus-visible:outline-offset-[-2px]"
          />
          <div className="pointer-events-none relative z-[1] flex flex-col gap-1 p-3">
            <div className="flex w-full items-start gap-2">
              <span id={`${domId}-name`} className="line-clamp-2 min-w-0 flex-1 text-[15px] leading-5 font-bold break-words">
                {card.company_name}
              </span>
              {showOwner && owner ? (
                <span aria-hidden="true" title={owner} className="grid size-6 shrink-0 place-items-center rounded-full bg-muted font-mono text-[10px] text-muted-foreground">
                  {initials(card.owner_first_name, card.owner_last_name)}
                </span>
              ) : null}
            </div>
            <div id={`${domId}-details`} className="flex flex-col gap-1">
              {showOwner && owner ? <span className="sr-only">{t("owner", { name: owner })}.</span> : null}
              <span className="line-clamp-1 min-h-5 text-[13px] leading-5 text-muted-foreground">{card.title ?? card.contact_name ?? t("untitled")}</span>
              <span className="flex min-h-8 items-center gap-2">
                {card.value !== null ? (
                  <span className="font-mono text-sm font-medium tabular-nums">{formatMoney(card.value, locale)}</span>
                ) : (
                  <span className="text-[13px] text-muted-foreground underline decoration-dotted underline-offset-4">{t("addValue")}</span>
                )}
                {card.fulfilment === "direct_from_source" ? (
                  <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px] leading-4 text-muted-foreground">{t("supplierStock")}</span>
                ) : null}
                <span aria-hidden="true" className="flex-1" />
                {next && card.status === "open" ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => handlers?.onNext(card)}
                    aria-label={next === "won" ? t("markWon") : t("nextToLabel", { stage: tStage(next) })}
                    className="pointer-events-auto -my-1.5 min-h-8 rounded-md px-2 text-[12px] whitespace-nowrap text-muted-foreground transition-[background-color,color,opacity,transform] duration-150 hover:bg-muted hover:text-foreground active:scale-[0.97] max-lg:min-h-11 lg:opacity-0 lg:group-focus-within:opacity-100 lg:group-hover:opacity-100"
                  >
                    {next === "won" ? t("markWon") : t("nextTo", { stage: tStage(`short.${next}`) })}
                  </button>
                ) : null}
                {menuActions ? (
                  <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                    <DropdownMenuTrigger
                      tabIndex={-1}
                      aria-label={t("moreActions", { name: card.company_name })}
                      className="pointer-events-auto -my-1.5 grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-[background-color,color,transform] duration-150 hover:bg-muted hover:text-foreground active:scale-[0.97] max-lg:size-11"
                    >
                      <MoreHorizontal aria-hidden="true" strokeWidth={1.75} className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      aria-label={t("menu.label")}
                      onCloseAutoFocus={(e) => {
                        // Back to the card, not the ⋯ button (it is out of the tab order: one tab stop per card).
                        e.preventDefault();
                        document.querySelector<HTMLElement>(`[data-deal-main="${CSS.escape(card.id)}"]`)?.focus();
                      }}
                    >
                      <DealMenuItems card={card} kind="dropdown" actions={menuActions} />
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </span>
              <span className="text-[13px] leading-5 text-muted-foreground">{status}</span>
              {card.lead_status === "do_not_contact" ? (
                <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-status-red" />
                  {t("dnc")}
                </span>
              ) : null}
            </div>
          </div>
        </motion.article>
      </ContextMenuTrigger>
      {menuActions ? (
        <ContextMenuContent aria-label={t("menu.label")}>
          <DealMenuItems card={card} kind="context" actions={menuActions} />
        </ContextMenuContent>
      ) : null}
    </ContextMenu>
  );
});

/** The dragged copy under the pointer (DragOverlay): lifted 3% with the floating-layer shadow. */
export function DealCardGhost({ card }: { card: Card }) {
  const t = useTranslations("Deals");
  const locale = useLocale();
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : { scale: 1 }}
      animate={reduce ? undefined : { scale: 1.03 }}
      transition={springs.snappy}
      className="pointer-events-none min-h-[120px] cursor-grabbing rounded-lg border border-border bg-card p-3 shadow-[0_16px_48px_rgb(14_14_16/0.22)]"
    >
      <p className="line-clamp-2 text-[15px] leading-5 font-bold">{card.company_name}</p>
      <p className="line-clamp-1 text-[13px] leading-5 text-muted-foreground">{card.title ?? card.contact_name ?? t("untitled")}</p>
      <p className="mt-1 font-mono text-sm">{card.value !== null ? formatMoney(card.value, locale) : t("addValue")}</p>
    </motion.div>
  );
}
