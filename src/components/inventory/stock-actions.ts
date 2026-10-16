"use client";

import { useTranslations } from "next-intl";
import type { StockFailure, StockResult } from "@/lib/inventory/errors";

export type StepUp = { ensureFresh: (minSeconds?: number) => Promise<boolean>; requireFresh: () => Promise<boolean> };

/**
 * Runs a stock action; when the database asks for a fresh code (step_up), "Confirm it's you" opens and the same call
 * (same request id, so never twice) runs again. Returns null when the person cancels the code.
 */
export async function runWithStepUp<T>(stepUp: StepUp, run: () => Promise<StockResult<T>>): Promise<StockResult<T> | null> {
  let res: StockResult<T>;
  try {
    res = await run();
  } catch {
    return { ok: false, error: "unavailable" };
  }
  if (!res.ok && res.error === "step_up") {
    if (!(await stepUp.requireFresh())) return null;
    try {
      res = await run();
    } catch {
      return { ok: false, error: "unavailable" };
    }
  }
  return res;
}

/** The sentence for a refused stock action (never the database's own text). */
export function useStockErrorText() {
  const t = useTranslations("Inventory.errors");
  const th = useTranslations("Inventory.hints");
  return (f: StockFailure) => (f.error === "invalid" && f.hint ? th(f.hint) : t(f.error));
}

export function requestId() {
  return crypto.randomUUID();
}
