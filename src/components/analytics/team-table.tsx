"use client";

import { useLocale, useTranslations } from "next-intl";
import { AnalyticsCard, BlockError, Bone, EmptyLine } from "@/components/analytics/card";
import { DataTable } from "@/components/analytics/chart-frame";
import type { AnalyticsData } from "@/lib/analytics/fetch";
import { formatCount, formatPercent, teamRows, type TeamRow } from "@/lib/analytics/view";
import { formatMoney } from "@/lib/money";

// The Team block (design 4.3, Q8): managers and admins, team view only. More than seven measures across people, so the
// table is the form: one row per person sorted by name, no rank, numbers in DM Mono right-aligned; "Former team members"
// (entries whose author was deleted) last. On a phone, one compact card per person instead (no sideways scroll). Names
// are React text.

export function TeamCard({ data, loading, busy, onRetry }: { data: AnalyticsData | undefined; loading: boolean; busy: boolean; onRetry: () => void }) {
  const t = useTranslations("Analytics.team");
  const ta = useTranslations("Analytics");
  const locale = useLocale();
  const pct = (x: number | null) => (x === null ? t("none") : formatPercent(x, locale));
  const num = (n: number) => formatCount(n, locale);

  let body: React.ReactNode;
  if (loading && !data) body = <TeamSkeleton />;
  else if (!data || !data.team?.ok || !data.activity.ok || !data.pipeline.ok) body = <BlockError block={t("block")} onRetry={onRetry} />;
  else {
    const rows = teamRows(data.team.data, data.activity.data.by_person, data.pipeline.data.by_person, { former: ta("formerMembers"), noName: ta("noName") }, locale);
    if (rows.length === 0) body = <EmptyLine text={t("empty")} />;
    else {
      const columns = [
        { key: "person", label: t("person") },
        { key: "calls", label: t("calls"), numeric: true },
        { key: "reached", label: t("reached"), numeric: true },
        { key: "connect", label: t("connect"), numeric: true },
        { key: "emails", label: t("emails"), numeric: true },
        { key: "whatsapp", label: t("whatsapp"), numeric: true },
        { key: "meetings", label: t("meetings"), numeric: true },
        { key: "opened", label: t("opened"), numeric: true },
        { key: "won", label: t("won"), numeric: true },
        { key: "wonValue", label: t("wonValue"), numeric: true },
        { key: "lost", label: t("lost"), numeric: true },
        { key: "winRate", label: t("winRate"), numeric: true },
      ];
      const cells = (r: TeamRow) => [
        r.name,
        num(r.calls),
        num(r.reached),
        pct(r.connect),
        num(r.emails),
        num(r.whatsapp),
        num(r.meetings),
        num(r.opened),
        num(r.won),
        formatMoney(r.wonValue, locale),
        num(r.lost),
        pct(r.winRate),
      ];
      body = (
        <>
          <p className="text-sm text-muted-foreground">{t("caption")}</p>
          <div className="hidden md:block">
            <DataTable caption={t("title")} columns={columns} rows={rows.map((r) => ({ key: r.key, cells: cells(r) }))} />
          </div>
          <ul className="flex flex-col gap-3 md:hidden" aria-label={t("title")}>
            {rows.map((r) => {
              const values = cells(r);
              return (
                <li key={r.key} className="rounded-md border border-border p-3">
                  <p className="mb-2 font-bold">{r.name}</p>
                  <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm min-[480px]:grid-cols-2">
                    {columns.slice(1).map((c, i) => (
                      <div key={c.key} className="flex items-baseline justify-between gap-2">
                        <dt className="text-muted-foreground">{c.label}</dt>
                        <dd className="font-mono tabular-nums">{values[i + 1]}</dd>
                      </div>
                    ))}
                  </dl>
                </li>
              );
            })}
          </ul>
        </>
      );
    }
  }
  return (
    <AnalyticsCard heading={t("title")} labelId="analytics-team" busy={busy} className="col-span-12">
      {body}
    </AnalyticsCard>
  );
}

export function TeamSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      <Bone className="h-5 w-72 max-w-full" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex h-10 items-center gap-3">
          <Bone className="h-5 w-40" />
          <Bone className="ml-auto h-5 w-2/3" />
        </div>
      ))}
    </div>
  );
}
