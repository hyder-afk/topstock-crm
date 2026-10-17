"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ArrowLeft } from "lucide-react";
import { renameLocation, updateInventorySettings } from "@/app/(app)/inventory/settings/actions";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { useStockErrorText } from "@/components/inventory/stock-actions";
import type { InventorySettings } from "@/lib/inventory/types";

type Member = { id: string; first_name: string | null; last_name: string | null };

// Inventory settings (design 10.6, admins): the two place names, who gets Restock tasks (or nobody), and how long a hold
// lasts by default. 6e adds the sharing switch and the list of client links.
export function InventorySettingsForm({ initial, team }: { initial: InventorySettings; team: Member[] }) {
  const t = useTranslations("InventorySettings");
  const errorText = useStockErrorText();
  const toast = useToast();
  const id = useId();
  const [names, setNames] = useState({ warehouse: initial.warehouse_name, transit: initial.transit_name });
  const [saved, setSaved] = useState({ warehouse: initial.warehouse_name, transit: initial.transit_name });
  const [assignee, setAssignee] = useState(initial.alert_assignee_id ?? "");
  const [days, setDays] = useState(String(initial.hold_days));
  const [busy, setBusy] = useState<"places" | "rules" | null>(null);
  const [error, setError] = useState<{ part: "places" | "rules"; text: string } | null>(null);

  const savePlaces = async () => {
    if (busy) return;
    setBusy("places");
    setError(null);
    for (const kind of ["warehouse", "transit"] as const) {
      if (names[kind].trim() === saved[kind]) continue;
      const res = await renameLocation({ kind, name: names[kind].trim() }).catch(() => null);
      if (!res || !res.ok) {
        setBusy(null);
        setError({ part: "places", text: res ? errorText(res) : t("failed") });
        document.getElementById(`${id}-${kind}`)?.focus();
        return;
      }
    }
    setSaved({ warehouse: names.warehouse.trim(), transit: names.transit.trim() });
    setBusy(null);
    toast.show(t("saved"));
  };
  const saveRules = async () => {
    if (busy) return;
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > 90) {
      setError({ part: "rules", text: t("daysRange") });
      document.getElementById(`${id}-days`)?.focus();
      return;
    }
    setBusy("rules");
    setError(null);
    const res = await updateInventorySettings({ alertAssignee: assignee || null, holdDays: n }).catch(() => null);
    setBusy(null);
    if (!res || !res.ok) {
      setError({ part: "rules", text: res ? errorText(res) : t("failed") });
      return;
    }
    toast.show(t("saved"));
  };

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4 pt-2">
      <Link
        href="/inventory"
        className="-ml-2 inline-flex min-h-11 items-center gap-1 self-start rounded-md px-2 text-sm text-muted-foreground transition-[color,transform,scale] duration-150 hover:text-foreground active:scale-[0.97]"
      >
        <ArrowLeft aria-hidden="true" strokeWidth={1.75} className="size-4" />
        {t("back")}
      </Link>
      <h1 className="text-3xl font-bold sm:text-4xl">{t("title")}</h1>
      <form
        className="flex flex-col gap-4 rounded-lg bg-card p-5 sm:p-6"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void savePlaces();
        }}
      >
        <h2 className="text-lg font-bold">{t("places")}</h2>
        {(["warehouse", "transit"] as const).map((kind) => (
          <div key={kind} className="flex flex-col gap-2">
            <Label htmlFor={`${id}-${kind}`}>{t(kind)}</Label>
            <Input
              id={`${id}-${kind}`}
              value={names[kind]}
              onChange={(e) => setNames((s) => ({ ...s, [kind]: e.target.value }))}
              maxLength={80}
              autoComplete="off"
              dir="auto"
              aria-describedby={error?.part === "places" ? `${id}-perr` : undefined}
            />
          </div>
        ))}
        <FormMessage id={`${id}-perr`} tone="error">
          {error?.part === "places" ? error.text : null}
        </FormMessage>
        <Button type="submit" variant="neutral" className="self-end" aria-disabled={busy === "places" || undefined}>
          {busy === "places" ? t("saving") : t("save")}
        </Button>
      </form>
      <form
        className="flex flex-col gap-4 rounded-lg bg-card p-5 sm:p-6"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void saveRules();
        }}
      >
        <h2 className="text-lg font-bold">{t("rules")}</h2>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-assignee`}>{t("assignee")}</Label>
          <Select id={`${id}-assignee`} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">{t("nobody")}</option>
            {team.map((m) => (
              <option key={m.id} value={m.id}>
                {[m.first_name, m.last_name].filter(Boolean).join(" ") || t("noName")}
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted-foreground">{t("assigneeHint")}</p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-days`}>{t("holdDays")}</Label>
          <Input
            id={`${id}-days`}
            value={days}
            onChange={(e) => setDays(e.target.value.replace(/\D/g, "").slice(0, 2))}
            inputMode="numeric"
            className="w-32 text-right font-mono"
            aria-invalid={error?.part === "rules" || undefined}
            aria-describedby={`${id}-dhint${error?.part === "rules" ? ` ${id}-rerr` : ""}`}
          />
          <p id={`${id}-dhint`} className="text-xs text-muted-foreground">
            {t("holdDaysHint")}
          </p>
        </div>
        <FormMessage id={`${id}-rerr`} tone="error">
          {error?.part === "rules" ? error.text : null}
        </FormMessage>
        <Button type="submit" variant="neutral" className="self-end" aria-disabled={busy === "rules" || undefined}>
          {busy === "rules" ? t("saving") : t("save")}
        </Button>
      </form>
    </div>
  );
}
