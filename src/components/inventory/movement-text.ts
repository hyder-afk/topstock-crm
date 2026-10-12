"use client";

import { useTranslations } from "next-intl";
import type { Movement } from "@/lib/inventory/types";

/** What a ledger row did, in words (design 10.1: "Sold", "Correction +12", "Held", "Hold released", "Arrived", …). */
export function useMovementText() {
  const t = useTranslations("Inventory.movement");
  return (m: Pick<Movement, "kind" | "reason">) => {
    switch (m.kind) {
      case "receive":
        return t("receive");
      case "adjust_in":
      case "adjust_out":
        return m.reason === "count" ? t("count") : t("correction");
      case "transfer_out":
      case "transfer_in":
        return t("arrived");
      case "reserve":
        return t("reserve");
      case "release":
        return m.reason === "deal_lost" || m.reason === "deal_deleted" ? t("releaseDeal") : t("release");
      case "expire":
        return t("expire");
      case "ship":
        return t("ship");
      case "return":
        return t("return");
      case "import_in":
      case "import_out":
        return m.reason === "arrived" ? t("arrivedSheet") : t("import");
      default:
        return t("importUndo");
    }
  };
}

/** The signed change a row shows: pieces on hand for stock rows, held pieces for hold rows. */
export function movementDelta(m: Pick<Movement, "d_on_hand" | "d_reserved">): { value: number; held: boolean } {
  return m.d_on_hand !== 0 ? { value: m.d_on_hand, held: false } : { value: m.d_reserved, held: true };
}
