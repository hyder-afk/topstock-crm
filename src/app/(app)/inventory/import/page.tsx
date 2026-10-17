import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { StockImportWorkspace } from "@/components/stock-import/stock-workspace";
import { requireAdmin, stepUpSecondsLeft } from "@/lib/auth";
import type { StockImportBatch } from "@/lib/stock-import/types";

// Import a stock sheet (Day 6c): admins only; everyone else gets the standard 404, and the database refuses them too.
export default async function StockImportPage() {
  const { supabase, claims } = await requireAdmin();
  const t = await getTranslations("StockImport");
  const imports = await supabase.rpc("list_stock_imports", { p_limit: 20 });
  return (
    <div className="flex flex-1 flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link href="/inventory" className="inline-flex min-h-11 items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground active:opacity-60">
          <ChevronLeft aria-hidden="true" strokeWidth={1.75} className="size-4" />
          {t("back")}
        </Link>
        <h1 className="text-2xl font-bold tracking-[-0.03em] text-balance sm:text-3xl">{t("title")}</h1>
        <p className="max-w-[65ch] text-muted-foreground">{t("subtitle")}</p>
      </div>
      <StockImportWorkspace
        initialImports={imports.error ? null : ((imports.data ?? []) as StockImportBatch[])}
        stepUpSeconds={stepUpSecondsLeft(claims)}
      />
    </div>
  );
}
