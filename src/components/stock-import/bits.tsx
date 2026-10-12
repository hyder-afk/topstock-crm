"use client";

import { useFormatter, useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

// Small pieces shared by the stock import steps (the Day 3b import's look: dots and words, never colour alone).
export function Notice({ tone, children, role }: { tone: "amber" | "red" | "green"; children: React.ReactNode; role?: "alert" | "status" }) {
  const dot = tone === "amber" ? "bg-status-amber" : tone === "red" ? "bg-status-red" : "bg-status-green";
  return (
    <p role={role} className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-sm">
      <span aria-hidden="true" className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", dot)} />
      <span className="min-w-0 wrap-anywhere">{children}</span>
    </p>
  );
}

export function ValueSection({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="font-bold">{title}</h3>
        {hint ? <p className="max-w-[65ch] text-sm text-muted-foreground">{hint}</p> : null}
      </div>
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">{children}</ul>
    </section>
  );
}

export function ValueRow({
  label,
  count,
  needsChoice = false,
  amber = false,
  children,
}: {
  label: string;
  count: number | null;
  needsChoice?: boolean;
  amber?: boolean;
  children: React.ReactNode;
}) {
  const t = useTranslations("StockImport.match");
  const format = useFormatter();
  return (
    <li className="grid grid-cols-1 gap-2 p-4 sm:grid-cols-[minmax(0,1fr)_248px] sm:items-center">
      <div className="flex min-w-0 items-center gap-2">
        {needsChoice || amber ? (
          <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", needsChoice ? "bg-status-red" : "bg-status-amber")} />
        ) : null}
        <span className="truncate" title={label} translate="no">
          {label}
        </span>
        {count !== null ? (
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{t("rowsCount", { count, formatted: format.number(count) })}</span>
        ) : null}
        {needsChoice ? <span className="sr-only">{t("needsChoice")}</span> : null}
      </div>
      {children}
    </li>
  );
}

/** A count tile on the Check screen: a big number in DM Mono and its label. */
export function Tile({ label, value, tone }: { label: string; value: string; tone?: "red" | "amber" }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg bg-card p-4">
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        {tone ? <span aria-hidden="true" className={cn("size-1.5 rounded-full", tone === "red" ? "bg-status-red" : "bg-status-amber")} /> : null}
        {label}
      </span>
      <span className="font-mono text-2xl tabular-nums">{value}</span>
    </div>
  );
}
