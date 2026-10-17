"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { releaseHold, reserveStock } from "@/app/(app)/inventory/actions";
import { useToast } from "@/components/ui/toast";
import { refreshSales } from "@/components/sales/use-sales";
import { requestId, useStockErrorText } from "@/components/inventory/stock-actions";
import type { Place } from "@/lib/inventory/types";

type HoldLike = {
  id: string;
  product_id?: string;
  location: Place;
  company_id: string;
  deal_id: string | null;
  remaining: number;
  hold_until: string;
  note: string | null;
};

// Releasing a hold (design 10.1, "optimistic updates with Undo"): one tap, no code; the toast's Undo holds the same
// pieces again for the same lead, deal, place and end date (a new hold: the ledger keeps both rows).
export function useReleaseHold() {
  const t = useTranslations("Inventory.holds");
  const errorText = useStockErrorText();
  const toast = useToast();
  const queryClient = useQueryClient();
  return useCallback(
    async (hold: HoldLike, productId: string) => {
      const res = await releaseHold({ productId, reservationId: hold.id, pieces: null, requestId: requestId() }).catch(() => null);
      // The inventory, and the lead's Stock tab and the stock alerts, wherever the release was pressed.
      refreshSales(queryClient, hold.company_id);
      if (!res || !res.ok) {
        toast.show(res ? errorText(res) : t("failed"));
        return false;
      }
      toast.show(
        t("released"),
        {
          label: t("undo"),
          run: () =>
            void reserveStock({
              productId,
              companyId: hold.company_id,
              dealId: hold.deal_id,
              place: hold.location,
              pieces: hold.remaining,
              holdUntil: hold.hold_until,
              note: hold.note,
              requestId: requestId(),
            })
              .then((r) => {
                refreshSales(queryClient, hold.company_id);
                toast.show(r.ok ? t("reheld") : errorText(r));
              })
              .catch(() => toast.show(t("failed"))),
        },
        { duration: 10_000 },
      );
      return true;
    },
    [errorText, queryClient, t, toast],
  );
}
