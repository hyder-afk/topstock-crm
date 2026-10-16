"use server";

import { requireSession } from "@/lib/auth";
import { stockError, stockInvalid, type StockResult } from "@/lib/inventory/errors";
import { locationNameInput, settingsInput } from "@/lib/inventory/schemas";
import type { InventorySettings } from "@/lib/inventory/types";

// Inventory settings (design 10.6): admins only (the database refuses everyone else; the page is hidden from them too).

export async function updateInventorySettings(input: unknown): Promise<StockResult<InventorySettings>> {
  const parsed = settingsInput.safeParse(input);
  if (!parsed.success) return stockInvalid("hold_days");
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("update_inventory_settings", {
    p_alert_assignee: parsed.data.alertAssignee,
    p_hold_days: parsed.data.holdDays,
  });
  return error ? stockError(error) : { ok: true, data: data as InventorySettings };
}

export async function renameLocation(input: unknown): Promise<StockResult<null>> {
  const parsed = locationNameInput.safeParse(input);
  if (!parsed.success) return stockInvalid("location_name");
  const { supabase } = await requireSession();
  const { error } = await supabase.rpc("rename_location", { p_kind: parsed.data.kind, p_name: parsed.data.name });
  return error ? stockError(error) : { ok: true, data: null };
}
