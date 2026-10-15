"use client";

import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useInfiniteQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, phoneSheet } from "@/components/ui/dialog";
import type { Cursor, DealCard } from "@/lib/deals";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";

// "See all won" and "See lost deals" (Day 5 design D19 and 7.1): every closed deal of the scope, newest close first,
// in keyset pages of 50 (list_stage_deals on won or lost, no age limit). A row opens the deal sheet.
export function ClosedDealsDialog({
  kind,
  scope,
  owner,
  onClose,
  onOpenDeal,
}: {
  kind: "won" | "lost" | null;
  scope: "team" | "mine";
  owner: string | null;
  onClose: () => void;
  onOpenDeal: (id: string) => void;
}) {
  return (
    <Dialog open={!!kind} onOpenChange={(o) => (o ? null : onClose())}>
      {kind ? <ClosedList kind={kind} scope={scope} owner={owner} onOpenDeal={onOpenDeal} /> : null}
    </Dialog>
  );
}

function ClosedList({ kind, scope, owner, onOpenDeal }: { kind: "won" | "lost"; scope: "team" | "mine"; owner: string | null; onOpenDeal: (id: string) => void }) {
  const t = useTranslations("Pipeline");
  const tD = useTranslations("Deals");
  const tR = useTranslations("LostReasons");
  const tC = useTranslations("Common");
  const locale = useLocale();
  const format = useFormatter();
  const q = useInfiniteQuery({
    queryKey: ["pipeline", "closed", kind, scope, owner],
    initialPageParam: null as Cursor,
    getNextPageParam: (last: { cards: DealCard[]; next: Cursor }) => last.next,
    queryFn: async ({ pageParam }) => {
      const p = new URLSearchParams({ stage: kind, scope });
      if (owner) p.set("owner", owner);
      if (pageParam) {
        p.set("after_at", pageParam.after_at);
        p.set("after_id", pageParam.after_id);
      }
      const res = await fetch(`/api/pipeline/stage?${p}`, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as { cards: DealCard[]; next: Cursor };
    },
  });
  const rows = q.data?.pages.flatMap((p) => p.cards) ?? [];
  return (
    <DialogContent className={cn(phoneSheet, "flex max-h-[calc(100dvh-24px)] flex-col sm:max-h-[76vh] sm:w-[min(560px,calc(100%-32px))]")}>
      <div className="flex items-start justify-between gap-3 border-b border-border p-5">
        <div>
          <DialogTitle className="text-xl font-bold">{t(`closedTitle.${kind}`)}</DialogTitle>
          <DialogDescription className="sr-only">{t(`closedTitle.${kind}`)}</DialogDescription>
        </div>
        <DialogClose aria-label={tC("dismiss")} className="-mr-2 grid size-11 place-items-center rounded-md text-muted-foreground transition-[color,scale] duration-150 hover:text-foreground active:scale-[0.97]">
          <X aria-hidden="true" strokeWidth={1.75} className="size-5" />
        </DialogClose>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
        {q.isPending ? (
          <div aria-busy="true" className="flex flex-col gap-2 p-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-12 rounded-md bg-muted motion-safe:animate-pulse" />
            ))}
          </div>
        ) : q.isError ? (
          <div role="alert" className="flex flex-col items-start gap-2 p-3">
            <p className="text-sm">{t("loadMoreFailed")}</p>
            <Button variant="quiet" onClick={() => void q.refetch()}>
              {t("retry")}
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">{t(`closedEmpty.${kind}`)}</p>
        ) : (
          <ul className="flex flex-col">
            {rows.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => onOpenDeal(d.id)}
                  className="flex min-h-14 w-full items-center justify-between gap-3 rounded-md px-3 text-left transition-colors hover:bg-muted"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-bold">{d.company_name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {d.title ?? tD("untitled")}
                      {kind === "lost" && d.lost_reason ? ` · ${tR(d.lost_reason)}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    {d.value ? <span className="block font-mono text-sm tabular-nums">{formatMoney(d.value, locale)}</span> : null}
                    {d.closed_at ? <span className="block font-mono text-xs text-muted-foreground">{format.dateTime(new Date(d.closed_at), { day: "numeric", month: "short", year: "numeric" })}</span> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {q.hasNextPage ? (
          <Button variant="quiet" width="full" className="mt-2" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {t("showMore", { count: format.number(50) })}
          </Button>
        ) : null}
      </div>
    </DialogContent>
  );
}
