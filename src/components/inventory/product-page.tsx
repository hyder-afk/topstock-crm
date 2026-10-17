"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ArrowLeft } from "lucide-react";
import { useStepUp } from "@/components/auth/step-up-dialog";
import { ProductPanel, type Role } from "@/components/inventory/product-panel";
import type { ProductDetail } from "@/lib/inventory/types";

// The product page (phones, and deep links): Back to Inventory, then the same panel as the desktop split view.
export function ProductPage({ product, role, me, stepUpSeconds }: { product: ProductDetail; role: Role; me: string; stepUpSeconds: number }) {
  const t = useTranslations("Inventory.panel");
  const router = useRouter();
  const stepUpHook = useStepUp(stepUpSeconds, "bodyStock");
  const { ensureFresh, requireFresh } = stepUpHook;
  const stepUp = useMemo(() => ({ ensureFresh, requireFresh }), [ensureFresh, requireFresh]);
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 pt-2">
      <Link
        href="/inventory"
        className="-ml-2 inline-flex min-h-11 items-center gap-1 self-start rounded-md px-2 text-sm text-muted-foreground transition-[color,transform,scale] duration-150 hover:text-foreground active:scale-[0.97]"
      >
        <ArrowLeft aria-hidden="true" strokeWidth={1.75} className="size-4" />
        {t("back")}
      </Link>
      <div className="rounded-lg bg-card p-5">
        <ProductPanel id={product.id} role={role} me={me} stepUp={stepUp} initial={product} asPage onClose={() => router.push("/inventory")} />
      </div>
      {stepUpHook.dialog}
    </div>
  );
}
