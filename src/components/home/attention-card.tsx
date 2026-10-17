"use client";

import Link from "next/link";
import { useRef } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { CardError, Dot, HomeCard, RowSkeletons } from "@/components/home/home-card";
import type { AttentionItem, HomeAttention } from "@/lib/home";
import { formatMoney } from "@/lib/money";
import { useKeepFocus } from "@/lib/use-keep-focus";

// Needs attention (Day 5 design 7.10, home_attention): up to 5 open deals, worst first: close date passed (the red
// token, with the words), stalled ("● Stalled · no move or contact for 16 days", amber dot plus words), closing within 7
// days. A row opens the deal sheet over Home; "See all 7 on the board" opens the board's stalled view.

function Row({ item, onOpen }: { item: AttentionItem; onOpen: (id: string) => void }) {
  const t = useTranslations("Home.attention");
  const tStage = useTranslations("Stages");
  const format = useFormatter();
  const locale = useLocale();
  const date = (d: string) => format.dateTime(new Date(`${d}T12:00:00Z`), { day: "numeric", month: "short", timeZone: "UTC" });
  const reason =
    item.reason === "overdue" && item.expected_close ? (
      <span className="font-bold text-status-red">{t("closePassed", { date: date(item.expected_close) })}</span>
    ) : item.reason === "stalled" ? (
      // Wraps to a second line rather than losing the day count (the French line is about 20 % longer; Day 7c).
      <span className="inline-flex min-w-0 items-start gap-1.5 text-foreground">
        <span className="flex h-4 shrink-0 items-center">
          <Dot tone="amber" />
        </span>
        <span className="line-clamp-2 text-pretty">{t("stalled", { days: item.quiet_days ?? 0 })}</span>
      </span>
    ) : item.expected_close ? (
      <span className="text-muted-foreground">{t("closing", { date: date(item.expected_close) })}</span>
    ) : null;
  return (
    <li>
      <button
        type="button"
        data-deal-row={item.id}
        onClick={() => onOpen(item.id)}
        className="flex min-h-14 w-full items-center gap-3 rounded-md px-2 text-left transition-[background-color,scale] duration-150 hover:bg-muted active:scale-[0.99] md:min-h-12"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm">
            {item.company_name}
            <span className="font-normal text-muted-foreground"> · {tStage(`short.${item.stage}`)}</span>
          </span>
          <span className="flex min-w-0 text-xs">{reason}</span>
        </span>
        <span className="shrink-0 font-mono text-sm">
          {item.value !== null ? formatMoney(item.value, locale) : <span className="font-sans text-xs text-muted-foreground">{t("noValue")}</span>}
        </span>
      </button>
    </li>
  );
}

export function AttentionCard({
  attention,
  title,
  loading,
  onRetry,
  onOpenDeal,
}: {
  attention: HomeAttention | null;
  title: string;
  loading: boolean;
  onRetry: () => void;
  onOpenDeal: (id: string) => void;
}) {
  const t = useTranslations("Home.attention");
  // A row that leaves after a refetch (the deal moved on) hands the focus to its neighbour or the heading, never <body>.
  const cardRef = useRef<HTMLElement>(null);
  useKeepFocus(cardRef, attention);
  return (
    <HomeCard ref={cardRef} labelId="home-attention" title={title} className="col-span-12 lg:col-span-7" busy={loading}>
      {loading ? (
        <RowSkeletons count={3} />
      ) : !attention ? (
        <CardError onRetry={onRetry} />
      ) : attention.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <>
          <ul className="-mx-2 flex flex-col">
            {attention.items.map((item) => (
              <Row key={item.id} item={item} onOpen={onOpenDeal} />
            ))}
          </ul>
          {attention.total > attention.items.length ? (
            <Link href="/pipeline?stalled=1" className="inline-flex min-h-11 items-center text-sm text-muted-foreground hover:text-foreground">
              {t("seeAll", { count: attention.total })}
            </Link>
          ) : null}
        </>
      )}
    </HomeCard>
  );
}
