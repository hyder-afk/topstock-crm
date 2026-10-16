"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { revokeShareLink, setSharingEnabled } from "@/app/(app)/inventory/share/actions";
import { useStepUp } from "@/components/auth/step-up-dialog";
import { runWithStepUp, useStockErrorText } from "@/components/inventory/stock-actions";
import { useShareLinks } from "@/components/share-links/link-card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

// Settings › Client links (design 10.6): the kill switch (on: an admin with a fresh code; off: at once) with a banner
// while it is off, and every active link across leads, last opened first, with Revoke. "What clients see" opens the
// team preview.
export function SharingSettings({ initialOn, stepUpSeconds }: { initialOn: boolean; stepUpSeconds: number }) {
  const t = useTranslations("InventorySettings");
  const tl = useTranslations("ShareLinks");
  const format = useFormatter();
  const errorText = useStockErrorText();
  const toast = useToast();
  const queryClient = useQueryClient();
  const id = useId();
  const stepUpHook = useStepUp(stepUpSeconds, "bodyStock");
  const [on, setOn] = useState(initialOn);
  const [busy, setBusy] = useState<string | null>(null);
  const query = useShareLinks(null);
  const links = [...(query.data?.links ?? [])].sort((a, b) => (b.last_opened_at ?? "").localeCompare(a.last_opened_at ?? ""));

  const toggle = async () => {
    if (busy) return;
    setBusy("switch");
    const res = await runWithStepUp(stepUpHook, () => setSharingEnabled({ on: !on }));
    setBusy(null);
    if (!res) return;
    if (!res.ok) {
      toast.show(errorText(res));
      return;
    }
    setOn(res.data.sharing_enabled);
    void queryClient.invalidateQueries({ queryKey: ["share-links"] });
    toast.show(res.data.sharing_enabled ? t("switchedOn") : t("switchedOff"));
  };
  const revoke = async (linkId: string) => {
    if (busy) return;
    setBusy(linkId);
    const res = await revokeShareLink(linkId).catch(() => null);
    setBusy(null);
    void queryClient.invalidateQueries({ queryKey: ["share-links"] });
    toast.show(res?.ok ? tl("revoked") : errorText(res ?? { ok: false, error: "unavailable" }));
  };

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-4 rounded-lg bg-card p-5 sm:p-6">
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-title`} className="text-lg font-bold">
          {t("sharingTitle")}
        </h2>
        <p className="max-w-[65ch] text-sm text-muted-foreground">{t("sharingBody")}</p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-muted p-3">
        <p className="flex items-center gap-2 text-sm font-bold" role="status">
          <span aria-hidden="true" className={`size-2 rounded-full ${on ? "bg-status-green" : "bg-status-amber"}`} />
          {on ? t("sharingOn") : t("sharingOffState")}
        </p>
        <Button variant={on ? "quiet" : "neutral"} onClick={() => void toggle()} aria-disabled={busy === "switch" || undefined}>
          {on ? t("switchOff") : t("switchOn")}
        </Button>
      </div>
      <Link href="/inventory/client-view" className="inline-flex min-h-11 items-center gap-1 self-start text-sm font-bold underline underline-offset-4">
        {t("clientView")}
        <ChevronRight aria-hidden="true" strokeWidth={1.75} className="size-4" />
      </Link>
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-bold">{t("linksTitle")}</h3>
        {query.isPending ? (
          <div className="h-14 rounded-md bg-muted motion-safe:animate-pulse" aria-hidden="true" />
        ) : query.isError ? (
          <div className="flex flex-wrap items-center gap-2 text-sm" role="alert">
            {t("linksError")}
            <Button variant="link" onClick={() => void query.refetch()}>
              {tl("retry")}
            </Button>
          </div>
        ) : links.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("linksEmpty")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {links.map((l) => (
              <li key={l.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 flex-col gap-0.5 text-sm">
                  {/* 20 px tall in the row; on phones the tap area reaches 44 px (Day 7c phone pass). */}
                  <Link
                    href={`/leads/${l.company_id}?tab=stock`}
                    className="relative flex max-w-full min-w-0 self-start font-bold underline-offset-4 hover:underline max-sm:before:absolute max-sm:before:inset-x-0 max-sm:before:-inset-y-3 max-sm:before:min-w-11 max-sm:before:content-['']"
                    dir="auto"
                  >
                    <span className="truncate">{l.company_name}</span>
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    {[
                      l.last_opened_at ? tl("opened", { when: format.relativeTime(new Date(l.last_opened_at)) }) : tl("neverOpened"),
                      tl("opens", { count: l.open_count }),
                      tl("requests", { count: l.request_count }),
                      tl("validUntil", { date: format.dateTime(new Date(l.expires_at), { day: "numeric", month: "short", year: "numeric" }) }),
                    ].join(" · ")}
                  </span>
                </div>
                <Button
                  variant="quiet"
                  className="min-h-11 shrink-0 px-3 text-sm sm:min-h-9"
                  onClick={() => void revoke(l.id)}
                  aria-label={tl("revokeLabel", { date: format.dateTime(new Date(l.created_at), { day: "numeric", month: "short" }) })}
                >
                  {tl("revoke")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {stepUpHook.dialog}
    </section>
  );
}
