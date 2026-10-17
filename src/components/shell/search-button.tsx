"use client";

import { useTranslations } from "next-intl";
import { Search } from "lucide-react";
import { useShell } from "@/components/shell/keyboard-layer";
import { Kbd } from "@/components/ui/kbd";
import { useModKey } from "@/lib/use-platform";

// Top-bar entry to the command menu: a labelled pill with its shortcut from small tablets up, an icon on phones.
export function SearchButton() {
  const t = useTranslations("Header");
  const { openPalette } = useShell();
  const mod = useModKey();
  return (
    <button
      type="button"
      onClick={openPalette}
      aria-label={t("search")}
      aria-keyshortcuts="Meta+K Control+K /"
      className="inline-flex min-h-11 items-center gap-2 rounded-md bg-muted px-3 text-sm text-muted-foreground transition-[color,transform,scale] duration-150 hover:text-foreground active:scale-[0.97] sm:min-h-9 sm:min-w-56"
    >
      <Search aria-hidden="true" strokeWidth={1.75} className="size-5 sm:size-4" />
      <span className="hidden flex-1 text-left sm:inline">{t("searchHint")}</span>
      {mod ? (
        <span aria-hidden="true" className="hidden gap-1 sm:flex">
          <Kbd>{mod}</Kbd>
          <Kbd>K</Kbd>
        </span>
      ) : null}
    </button>
  );
}
