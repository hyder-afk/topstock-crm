import { getTranslations } from "next-intl/server";
import { ImportWorkspace } from "@/components/import/import-workspace";
import { requireAdmin, stepUpSecondsLeft } from "@/lib/auth";
import type { ImportBatch } from "@/lib/import-server";
import { fetchTeam } from "@/lib/leads-server";

// Import leads from a CSV file (Day 3b; Cloud Workflow section 7: an admin-only page with step-up MFA). Everyone else
// gets the standard 404, and the database refuses them too.
export default async function ImportLeadsPage() {
  const { supabase, claims, timezone } = await requireAdmin();
  const t = await getTranslations("Import");
  const [imports, team] = await Promise.all([supabase.rpc("list_lead_imports", { p_limit: 20 }), fetchTeam(supabase)]);
  return (
    <div className="flex flex-1 flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-[-0.03em] text-balance sm:text-3xl">{t("title")}</h1>
        <p className="max-w-[65ch] text-muted-foreground">{t("subtitle")}</p>
      </div>
      <ImportWorkspace
        initialImports={imports.error ? null : ((imports.data ?? []) as ImportBatch[])}
        team={team ?? []}
        stepUpSeconds={stepUpSecondsLeft(claims)}
        timeZone={timezone}
        me={claims.sub}
      />
    </div>
  );
}
