"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

// The pieces every Home card shares (Day 5 design 7.10): a titled card, its error line with Retry, and row skeletons
// with the final rows' height (no spinners). Each card shows its own loading, empty and error states.

export function HomeCard({
  title,
  action,
  className,
  children,
  busy,
  labelId,
}: {
  title: string;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
  busy?: boolean;
  labelId: string;
}) {
  return (
    <section
      aria-labelledby={labelId}
      aria-busy={busy || undefined}
      className={cn("flex min-w-0 flex-col gap-3 rounded-lg bg-card p-4 sm:p-6", className)}
    >
      <div className="flex min-h-7 items-center justify-between gap-3">
        <h2 id={labelId} tabIndex={-1} className="truncate rounded-sm text-lg font-bold">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** "Couldn't load · Retry" inside a card (the rest of Home keeps working). */
export function CardError({ message, onRetry }: { message?: string; onRetry: () => void }) {
  const t = useTranslations("Home");
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
      <span>{message ?? t("loadFailed")}</span>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex min-h-11 items-center font-bold text-foreground underline underline-offset-4 transition-[scale] duration-150 active:scale-[0.97]"
      >
        {t("retry")}
      </button>
    </div>
  );
}

/** Row placeholders at the rows' own height (56 px on phones, 48 px from tablet width up). */
export function RowSkeletons({ count, className }: { count: number; className?: string }) {
  return (
    <div className={cn("flex flex-col", className)} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex h-14 items-center gap-3 md:h-12">
          <div className="h-5 w-2/3 rounded-sm bg-muted motion-safe:animate-pulse" />
          <div className="ml-auto h-5 w-16 rounded-sm bg-muted motion-safe:animate-pulse" />
        </div>
      ))}
    </div>
  );
}

export function Dot({ tone }: { tone: "amber" | "red" | "green" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        tone === "amber" ? "bg-status-amber" : tone === "red" ? "bg-status-red" : "bg-status-green",
      )}
    />
  );
}
