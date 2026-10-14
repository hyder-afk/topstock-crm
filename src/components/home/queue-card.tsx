"use client";

import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { HomeCard } from "@/components/home/home-card";
import { useQueueSummary } from "@/components/home/use-home";
import { buttonVariants } from "@/components/ui/button";
import type { HomeSummary } from "@/lib/home";
import { cn } from "@/lib/utils";

// Work queue (Day 5 design 7.10): "412 to call now · 1,030 later today" (DM Mono) from Day 4c's queue_summary, loaded
// after paint (['queue', 'summary']); the week's new leads from home_summary (org-wide); the red Start calling. The
// button works whether or not the count loaded. REBASE: re-copy after 4c/4d merge. The work queue page and its "G Q"
// shortcut come with Day 4c; wire this card to 4c's queue card pieces then (the Kbd hint joins the button).

export function QueueCard({ newLeads }: { newLeads: HomeSummary["new_leads"] | null }) {
  const t = useTranslations("Home.queue");
  const format = useFormatter();
  const queue = useQueueSummary();
  return (
    <HomeCard labelId="home-queue" title={t("title")} className="col-span-12 lg:col-span-5">
      <div className="flex min-h-12 flex-col justify-center gap-1">
        {queue.isPending ? (
          <div className="h-5 w-56 max-w-full rounded-sm bg-muted motion-safe:animate-pulse" aria-hidden="true" />
        ) : queue.isError || !queue.data ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t("failed")}
          </p>
        ) : "ready" in queue.data ? (
          <p className="text-sm text-muted-foreground">{t("notReady")}</p>
        ) : queue.data.callable_now + queue.data.later_today === 0 ? (
          <p className="text-sm text-muted-foreground">{t("nobody")}</p>
        ) : (
          <p className="font-mono text-sm">
            {t("counts", { now: format.number(queue.data.callable_now), later: format.number(queue.data.later_today) })}
          </p>
        )}
        {newLeads ? (
          <p className="text-sm text-muted-foreground">
            {t("newLeads", { count: newLeads.count })}
            {newLeads.imported > 0 ? ` ${t("imported", { count: format.number(newLeads.imported) })}` : null}
          </p>
        ) : null}
      </div>
      <Link
        href="/leads/queue"
        className={cn(buttonVariants({ variant: "brand", width: "full" }), "mt-auto min-h-14 sm:min-h-11 lg:w-fit")}
      >
        {t("start")}
      </Link>
    </HomeCard>
  );
}
