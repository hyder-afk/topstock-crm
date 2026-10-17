"use client";

import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { ArrowLeft } from "lucide-react";
import { ShareList } from "@/components/share/share-list";
import type { SharePreview } from "@/lib/share-links-server";

// What clients see (design 10.6): the client page's own list component on the team's data, with a banner. It builds
// trust in the whitelist (max price per piece, never costs or minimum prices) and doubles as a visual test of it.
export function ClientView({ preview }: { preview: SharePreview | null }) {
  const t = useTranslations("Inventory");
  const ts = useTranslations("Share");
  const tset = useTranslations("InventorySettings");
  const format = useFormatter();
  return (
    <div className="mx-auto flex w-full max-w-[720px] min-w-0 flex-col gap-5 pt-2">
      <Link href="/inventory" className="inline-flex min-h-11 items-center gap-2 self-start text-sm text-muted-foreground hover:text-foreground active:opacity-60">
        <ArrowLeft aria-hidden="true" strokeWidth={1.75} className="size-4" />
        {t("clientViewBack")}
      </Link>
      <div className="flex flex-col gap-1 rounded-lg bg-card p-4">
        <p className="font-bold">{ts("previewBanner")}</p>
        <p className="max-w-[65ch] text-sm text-muted-foreground">{t("clientViewBody")}</p>
        {preview && !preview.sharing_enabled ? (
          <p className="mt-1 flex items-center gap-2 text-sm">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-status-amber" />
            {tset("sharingOffState")}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h1 className="text-2xl font-bold text-balance">{t("clientView")}</h1>
        {preview ? (
          <p className="font-mono text-sm text-muted-foreground tabular-nums">
            {ts("updated", { time: format.dateTime(new Date(preview.generated_at), { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) })}
          </p>
        ) : null}
      </div>
      {!preview ? (
        <p className="rounded-lg bg-card p-4" role="alert">
          {t("clientViewError")}
        </p>
      ) : preview.items.length === 0 ? (
        <p className="rounded-lg bg-card p-4">{ts("emptyTitle")}</p>
      ) : (
        <ShareList items={preview.items} showInTransit />
      )}
      {preview?.signature ? <p className="text-sm text-muted-foreground">{ts("contact", { name: preview.signature })}</p> : null}
      <p className="text-[13px] text-muted-foreground">{ts("footerPrices")}</p>
    </div>
  );
}
