"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { AnalyticsCard, BlockError, Bone, EmptyLine, blockView } from "@/components/analytics/card";
import { DataTable } from "@/components/analytics/chart-frame";
import type { AnalyticsData } from "@/lib/analytics/fetch";
import { batchHref, batchRows, formatCount, formatParisDate, formatPercent, type BatchRow, type BatchShare } from "@/lib/analytics/view";

// List quality per import (design 1.5, 4.1, 4.2, Q11): admins only (import batches are admin-only under row level
// security, and the database refuses everyone else). The newest imports, newest first: file · imported · leads · contacted
// % · reached % · deal % · won %, counting only entries and deals made after the import, of the leads in it now. With the
// person filter, the leads of each import that person owns. A table on wider screens; one card per import on a phone (no
// sideways scroll). The file name is the uploader's text: React text only, and a link to that import's leads in the Leads
// list. Empty: "No imports yet." with Import leads.

export function ListQualityCard({ data, loading, busy, onRetry }: { data: AnalyticsData | undefined; loading: boolean; busy: boolean; onRetry: () => void }) {
  const t = useTranslations("Analytics.listQuality");
  const locale = useLocale();
  const view = blockView(data?.batches ?? undefined, loading);
  const owner = data?.rep ?? null;
  const share = (s: BatchShare) =>
    s.share === null ? "—" : <span className="whitespace-nowrap">{t("share", { rate: formatPercent(s.share, locale), count: formatCount(s.count, locale) })}</span>;
  const file = (r: BatchRow) => (
    <Link
      href={batchHref(r.id, owner)}
      className="inline-flex min-h-11 items-center font-bold [overflow-wrap:anywhere] underline-offset-4 hover:underline md:min-h-0"
      data-batch-file=""
      translate="no"
    >
      {r.filename}
    </Link>
  );
  const leads = (r: BatchRow) =>
    r.leads === 0 ? <span className="font-sans text-muted-foreground">{t("allRemoved")}</span> : formatCount(r.leads, locale);

  let body: React.ReactNode;
  if (view.kind === "loading") body = <ListQualitySkeleton />;
  else if (view.kind === "error") body = <BlockError block={t("block")} onRetry={onRetry} />;
  else if (view.data.length === 0) body = <EmptyLine text={t("empty")} href="/leads/import" action={t("emptyAction")} />;
  else {
    const rows = batchRows(view.data);
    const columns = [
      { key: "file", label: t("file") },
      { key: "imported", label: t("imported") },
      { key: "leads", label: t("leads"), numeric: true },
      { key: "contacted", label: t("contacted"), numeric: true },
      { key: "reached", label: t("reached"), numeric: true },
      { key: "deal", label: t("deal"), numeric: true },
      { key: "won", label: t("won"), numeric: true },
    ];
    const cells = (r: BatchRow) => [
      file(r),
      <span key="d" className="whitespace-nowrap text-muted-foreground">
        {formatParisDate(r.createdAt, locale)}
      </span>,
      leads(r),
      share(r.contacted),
      share(r.reached),
      share(r.deal),
      share(r.won),
    ];
    body = (
      <>
        <p className="text-sm text-muted-foreground">{t("caption")}</p>
        <div className="hidden md:block" data-batches="table">
          <DataTable caption={t("title")} columns={columns} rows={rows.map((r) => ({ key: r.key, cells: cells(r) }))} />
        </div>
        <ul className="flex flex-col gap-3 md:hidden" aria-label={t("title")} data-batches="cards">
          {rows.map((r) => (
            <li key={r.key} className="rounded-md border border-border p-3" data-batch-card="">
              <div className="mb-2 flex flex-col">
                {file(r)}
                <span className="text-[13px] text-muted-foreground">
                  {t("imported")} {formatParisDate(r.createdAt, locale)}
                </span>
              </div>
              <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm min-[480px]:grid-cols-2">
                {(
                  [
                    ["leads", leads(r)],
                    ["contacted", share(r.contacted)],
                    ["reached", share(r.reached)],
                    ["deal", share(r.deal)],
                    ["won", share(r.won)],
                  ] as const
                ).map(([key, value]) => (
                  <div key={key} className="flex items-baseline justify-between gap-2">
                    <dt className="text-muted-foreground">{t(key)}</dt>
                    <dd className="text-right font-mono tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      </>
    );
  }
  return (
    <AnalyticsCard heading={t("title")} labelId="analytics-list-quality" busy={busy} className="col-span-12">
      {body}
    </AnalyticsCard>
  );
}

export function ListQualitySkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      <Bone className="h-5 w-96 max-w-full" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex h-10 items-center gap-3">
          <Bone className="h-5 w-48" />
          <Bone className="ml-auto h-5 w-1/2" />
        </div>
      ))}
    </div>
  );
}
