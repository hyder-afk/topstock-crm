"use client";

import { useSyncExternalStore, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { setLocale } from "@/app/actions";
import { locales } from "@/i18n/config";
import { cn } from "@/lib/utils";

const themes = ["light", "dark", "system"] as const;

// The theme is only known in the browser; render it after hydration so server and client markup match.
const noopSubscribe = () => () => {};
function useHydrated() {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  render,
}: {
  label: string;
  options: readonly T[];
  value: T | undefined;
  onChange: (v: T) => void;
  render: (v: T) => string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-md bg-muted p-1">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          aria-pressed={value === o}
          onClick={() => onChange(o)}
          className={cn(
            "min-h-11 min-w-11 rounded-sm px-3 text-sm sm:min-h-9 sm:min-w-0 transition-[background-color,color,transform] duration-150 active:scale-[0.97]",
            value === o ? "bg-pill text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {render(o)}
        </button>
      ))}
    </div>
  );
}

export function SettingsBar() {
  const t = useTranslations("Settings");
  const locale = useLocale();
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const hydrated = useHydrated();
  const [, startTransition] = useTransition();
  const themeLabel = { light: t("themeLight"), dark: t("themeDark"), system: t("themeSystem") };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Segmented
        label={t("language")}
        options={locales}
        value={locale as (typeof locales)[number]}
        onChange={(v) =>
          startTransition(async () => {
            await setLocale(v);
            router.refresh();
          })
        }
        render={(v) => v.toUpperCase()}
      />
      <Segmented
        label={t("theme")}
        options={themes}
        value={hydrated ? (theme as (typeof themes)[number]) : undefined}
        onChange={setTheme}
        render={(v) => themeLabel[v]}
      />
    </div>
  );
}
