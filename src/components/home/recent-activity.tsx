"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { CardError, HomeCard, RowSkeletons } from "@/components/home/home-card";
import { RECENT_SHOWN, type RecentRow } from "@/lib/home";
import { formatMoney } from "@/lib/money";

// Recent activity (Day 5 design 7.10, home_recent_activity): the latest entries and deal changes, newest first: "Kais ·
// Call · Interested · Maison Verdane · 10 min ago" or "Henri won Maison Verdane · €12,400". The time is relative, with
// the exact time as screen-reader text (Day 7b: no title= tooltip). A row opens the lead. The skeleton draws the
// RECENT_SHOWN rows the card holds. The feed never carries an entry's text or a lost note (the
// database's return type has no such column).

// Starts from when the server answered (the same instant on the server and in the browser, so the relative times
// hydrate identically), then ticks every minute.
function useNow(start: number): Date {
  const [now, setNow] = useState(() => new Date(start));
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

function Line({ row }: { row: RecentRow }) {
  const t = useTranslations("Home.recent");
  const tType = useTranslations("Composer.types");
  const tOutcome = useTranslations("Outcomes");
  const tStage = useTranslations("Stages");
  const locale = useLocale();
  const name = row.user_first_name?.trim() || t("someone");
  const lead = row.company_name ?? t("aLead");
  if (row.kind === "activity") {
    const outcome = row.outcome && tOutcome.has(row.outcome) ? tOutcome(row.outcome) : null;
    return <>{[name, row.type ? tType(row.type) : null, outcome, lead].filter(Boolean).join(" · ")}</>;
  }
  if (row.kind === "won") {
    return <>{t("won", { name, lead })}{row.value ? <> · <span className="font-mono">{formatMoney(row.value, locale)}</span></> : null}</>;
  }
  if (row.kind === "move") return <>{t("move", { name, lead, stage: row.to_stage ? tStage(row.to_stage) : "" })}</>;
  return <>{t(row.kind, { name, lead })}</>;
}

export function RecentActivity({
  recent,
  title,
  loading,
  onRetry,
  answeredAt,
}: {
  answeredAt: number;
  recent: RecentRow[] | null;
  title: string;
  loading: boolean;
  onRetry: () => void;
}) {
  const t = useTranslations("Home.recent");
  const format = useFormatter();
  const now = useNow(answeredAt);
  return (
    <HomeCard labelId="home-recent" title={title} className="col-span-12 lg:col-span-7" busy={loading}>
      {loading ? (
        <RowSkeletons count={RECENT_SHOWN} />
      ) : !recent ? (
        <CardError onRetry={onRetry} />
      ) : recent.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="-mx-2 flex flex-col">
          {recent.map((row) => {
            const at = new Date(row.at);
            const body = (
              <>
                <span className="line-clamp-2 min-w-0 flex-1 text-sm md:line-clamp-1">
                  <Line row={row} />
                </span>
                <time dateTime={row.at} className="shrink-0 text-xs text-muted-foreground">
                  {format.relativeTime(at, now)}
                  <span className="sr-only"> ({format.dateTime(at, { dateStyle: "medium", timeStyle: "short" })})</span>
                </time>
              </>
            );
            const cls = "flex min-h-14 items-center gap-3 rounded-md px-2 md:min-h-12";
            return (
              <li key={row.item_id}>
                {row.company_id ? (
                  <Link href={`/leads/${row.company_id}`} className={`${cls} transition-[background-color] duration-150 hover:bg-muted`}>
                    {body}
                  </Link>
                ) : (
                  <div className={cls}>{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </HomeCard>
  );
}
