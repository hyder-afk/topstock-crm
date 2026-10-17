"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import type { Part } from "@/lib/home";
import { cn } from "@/lib/utils";

// The pieces every Analytics card shares (design 4.1, 4.7): a titled card (radius 20, padding 24, sentence-case title),
// its own skeleton, empty line and error line with Try again. A card loads with a skeleton only when its view has no
// figures yet; during a refetch it keeps its last frame and says it is busy (aria-busy).

export function AnalyticsCard({
  heading,
  labelId,
  busy,
  className,
  action,
  children,
}: {
  heading: string;
  labelId: string;
  busy?: boolean;
  className?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby={labelId}
      aria-busy={busy || undefined}
      data-block={labelId}
      className={cn("flex min-w-0 flex-col gap-3 rounded-lg bg-card p-4 sm:p-6", className)}
    >
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h3 id={labelId} className="text-lg font-bold">
          {heading}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** "Couldn't load {block} · Try again" inside a card; the rest of the page keeps working. */
export function BlockError({ block, onRetry }: { block: string; onRetry: () => void }) {
  const t = useTranslations("Analytics");
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground" data-block-error="">
      <span>{t("loadFailed", { block })}</span>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex min-h-11 items-center font-bold text-foreground underline underline-offset-4 hover:decoration-2 transition-[scale] duration-150 active:scale-[0.97]"
      >
        {t("tryAgain")}
      </button>
    </div>
  );
}

/** A calm one-line empty state, with its action when there is one. */
export function EmptyLine({ text, href, action }: { text: string; href?: string; action?: string }) {
  return (
    <div className="flex flex-col items-start gap-1 text-sm text-muted-foreground" data-empty="">
      <p>{text}</p>
      {href && action ? (
        <Link href={href} className="inline-flex min-h-11 items-center font-bold text-foreground underline underline-offset-4 hover:decoration-2">
          {action}
        </Link>
      ) : null}
    </div>
  );
}

export function Bone({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div aria-hidden="true" className={cn("rounded-sm bg-muted motion-safe:animate-pulse", className)} style={style} />;
}

/** What a block shows: its skeleton while its view has no figures yet, its error, or its figures. */
export type BlockView<T> = { kind: "loading" } | { kind: "error" } | { kind: "ok"; data: T };
export function blockView<T>(part: Part<T> | undefined, loading: boolean): BlockView<T> {
  if (part === undefined) return loading ? { kind: "loading" } : { kind: "error" };
  return part.ok ? { kind: "ok", data: part.data } : { kind: "error" };
}

const narrowQuery = "(max-width: 639.98px)";
function subscribe(callback: () => void) {
  const m = window.matchMedia(narrowQuery);
  m.addEventListener("change", callback);
  return () => m.removeEventListener("change", callback);
}
/** A phone-width screen (the charts' tick spacing and label lengths; layout itself is CSS). False on the server. */
export function useNarrow(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(narrowQuery).matches, () => false);
}
