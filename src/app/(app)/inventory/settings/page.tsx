import { InventorySettingsForm } from "@/components/inventory/settings-form";
import { SharingSettings } from "@/components/share-links/sharing-settings";
import { requireAdmin, stepUpSecondsLeft } from "@/lib/auth";
import { fetchInventorySettings } from "@/lib/inventory-server";
import { fetchTeam } from "@/lib/leads-server";

// Inventory settings (design 10.6): admins only (everyone else gets the standard 404; the database refuses them too).
export default async function InventorySettingsPage() {
  const { supabase, claims } = await requireAdmin();
  const [settings, team] = await Promise.all([fetchInventorySettings(supabase), fetchTeam(supabase)]);
  if (!settings) throw new Error("settings unavailable");
  return (
    <div className="flex flex-col gap-6">
      <InventorySettingsForm initial={settings} team={(team ?? []).map((m) => ({ id: m.id, first_name: m.first_name, last_name: m.last_name }))} />
      {/* 6e: the sharing switch and every active client link. */}
      <div className="mx-auto w-full max-w-[720px]">
        <SharingSettings initialOn={settings.sharing_enabled} stepUpSeconds={stepUpSecondsLeft(claims)} />
      </div>
    </div>
  );
}
