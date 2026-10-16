"use client";

import { useTranslations } from "next-intl";
import { ArrowRight, CircleCheck, CircleX, Copy, ExternalLink, PencilLine, RotateCcw, Trash2, Undo2 } from "lucide-react";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { openStageKeys, type DealCard, type OpenStageKey } from "@/lib/deals";

// The card menu (Day 5 design 7.2), the same items in the right-click menu and the ⋯ menu: Move to ▸ (1 to 3), Mark
// won… (4), Mark lost… (5), Reopen… (closed deals), Edit value (E), Open lead (O), Copy link, Undo last move (U, 2
// minutes), Delete… (a fresh code). Every item shows its key. Items a person may not use are left out (read-only card).
// Reopen and Delete are null when they are not offered (Day 7: lib/deals reopenOffered and deleteOffered, which also leave
// them out while stock records hold the deal, as far as the board knows, and Delete after the creator's 120 s).
export type DealMenuActions = {
  move: (to: OpenStageKey) => void;
  win: () => void;
  lose: () => void;
  reopen: (() => void) | null;
  editValue: () => void;
  openLead: () => void;
  copyLink: () => void;
  undo: (() => void) | null;
  remove: (() => void) | null;
};

const parts = {
  context: { Item: ContextMenuItem, Separator: ContextMenuSeparator, Sub: ContextMenuSub, SubTrigger: ContextMenuSubTrigger, SubContent: ContextMenuSubContent },
  dropdown: { Item: DropdownMenuItem, Separator: DropdownMenuSeparator, Sub: DropdownMenuSub, SubTrigger: DropdownMenuSubTrigger, SubContent: DropdownMenuSubContent },
} as const;

const DIGIT: Record<OpenStageKey, string> = { lead: "1", qualified: "2", negotiations: "3" };

export function DealMenuItems({ card, kind, actions }: { card: DealCard; kind: keyof typeof parts; actions: DealMenuActions }) {
  const t = useTranslations("Deals.menu");
  const tStage = useTranslations("Stages");
  const { Item, Separator, Sub, SubTrigger, SubContent } = parts[kind];
  const icon = "size-4 shrink-0 text-muted-foreground";
  const keyHint = (k: string) => (
    <Kbd aria-hidden="true" className="ml-auto">
      {k}
    </Kbd>
  );
  const open = card.status === "open";
  return (
    <>
      {card.can_edit && open ? (
        <>
          <Sub>
            <SubTrigger>
              <ArrowRight aria-hidden="true" strokeWidth={1.75} className={icon} />
              {t("moveTo")}
            </SubTrigger>
            <SubContent>
              {openStageKeys
                .filter((s) => s !== card.stage)
                .map((s) => (
                  <Item key={s} onSelect={() => actions.move(s)}>
                    {tStage(s)}
                    {keyHint(DIGIT[s])}
                  </Item>
                ))}
            </SubContent>
          </Sub>
          <Item onSelect={actions.win}>
            <CircleCheck aria-hidden="true" strokeWidth={1.75} className={icon} />
            {t("markWon")}
            {keyHint("4")}
          </Item>
          <Item onSelect={actions.lose}>
            <CircleX aria-hidden="true" strokeWidth={1.75} className={icon} />
            {t("markLost")}
            {keyHint("5")}
          </Item>
        </>
      ) : null}
      {actions.reopen ? (
        <Item onSelect={actions.reopen}>
          <RotateCcw aria-hidden="true" strokeWidth={1.75} className={icon} />
          {t("reopen")}
        </Item>
      ) : null}
      {card.can_edit && open ? (
        <Item onSelect={actions.editValue}>
          <PencilLine aria-hidden="true" strokeWidth={1.75} className={icon} />
          {t("editValue")}
          {keyHint("E")}
        </Item>
      ) : null}
      {/* Only under items drawn above: a won deal that stock records hold has none (no Reopen), so no leading line. */}
      {(card.can_edit && open) || actions.reopen ? <Separator /> : null}
      <Item onSelect={actions.openLead}>
        <ExternalLink aria-hidden="true" strokeWidth={1.75} className={icon} />
        {t("openLead")}
        {keyHint("O")}
      </Item>
      <Item onSelect={actions.copyLink}>
        <Copy aria-hidden="true" strokeWidth={1.75} className={icon} />
        {t("copyLink")}
      </Item>
      {actions.undo ? (
        <Item onSelect={actions.undo}>
          <Undo2 aria-hidden="true" strokeWidth={1.75} className={icon} />
          {t("undo")}
          {keyHint("U")}
        </Item>
      ) : null}
      {actions.remove ? (
        <>
          <Separator />
          <Item onSelect={actions.remove} className="text-status-red">
            <Trash2 aria-hidden="true" strokeWidth={1.75} className="size-4 shrink-0" />
            {t("delete")}
            {keyHint("Del")}
          </Item>
        </>
      ) : null}
    </>
  );
}
