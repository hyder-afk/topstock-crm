"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useQtyText } from "@/components/inventory/bits";
import type { Fulfilment, RequestLine, RequestStatus } from "@/lib/sales/types";
import { cn } from "@/lib/utils";

// Small shared pieces of the Day 6d screens: the sale type badge, the request status badge and the live availability
// sentence of a request line ("Asked 480 pcs · 4 200 available now").

export function SaleTypeBadge({ fulfilment, className }: { fulfilment: Fulfilment; className?: string }) {
  const t = useTranslations("Sales.fulfilment");
  return (
    <span className={cn("inline-flex max-w-full items-center rounded-sm bg-muted px-2 py-0.5 text-xs whitespace-nowrap text-foreground", className)}>
      <span className="truncate">{t(fulfilment)}</span>
    </span>
  );
}

const statusDot: Record<RequestStatus, string> = {
  new: "bg-status-red",
  in_progress: "bg-status-amber",
  done: "bg-status-green",
  declined: "bg-muted-foreground",
};

export function RequestStatusBadge({ status }: { status: RequestStatus }) {
  const t = useTranslations("Sales.requestStatus");
  return (
    <span className="inline-flex items-center gap-1.5 rounded-sm bg-muted px-2 py-0.5 text-xs whitespace-nowrap text-foreground">
      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", statusDot[status])} />
      {t(status)}
    </span>
  );
}

/** "Asked 480 pcs · 4 200 available now" / "· arriving week of 13 Oct" / "· not in stock: ask the supplier". */
export function useRequestLineText() {
  const t = useTranslations("Sales.wants");
  const qty = useQtyText();
  const format = useFormatter();
  return (l: RequestLine) => {
    const ppc = l.pieces_per_carton ?? 1;
    const asked = t("asked", { pieces: qty(l.pieces, ppc) });
    if (!l.product_id || !l.now) return `${asked} · ${t("notListed")}`;
    if (l.now.archived) return `${asked} · ${t("archived")}`;
    if (l.now.warehouse_available > 0) return `${asked} · ${t("availableNow", { pieces: qty(l.now.warehouse_available, ppc) })}`;
    if (l.now.transit_on_hand > 0)
      return `${asked} · ${
        l.now.transit_eta
          ? t("arrivingWeek", { date: format.dateTime(new Date(`${l.now.transit_eta}T12:00:00Z`), { day: "numeric", month: "short", timeZone: "UTC" }) })
          : t("arriving")
      }`;
    return `${asked} · ${t("noStock")}`;
  };
}

/** The tone dot of a request line: green when the warehouse can cover it, amber when part or arriving, grey otherwise. */
export function lineTone(l: RequestLine): "green" | "amber" | "none" {
  if (!l.now || l.now.archived) return "none";
  if (l.now.warehouse_available >= l.pieces) return "green";
  if (l.now.warehouse_available > 0 || l.now.transit_on_hand > 0) return "amber";
  return "none";
}

/** Moves the focus to a field of the form once React has drawn it (a picked option unmounts the search box: the focus
 * must never fall back to the page). */
export function focusField(formId: string, name: string, index = 0) {
  requestAnimationFrame(() => {
    const els = document.getElementById(formId)?.querySelectorAll<HTMLElement>(`[name="${name}"]`);
    els?.[Math.min(index, els.length - 1)]?.focus();
  });
}
