"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { Command } from "cmdk";
import { Eye, History, Inbox, Keyboard, Languages, LogOut, Monitor, Moon, Receipt, Search, Settings, Sun, Upload, type LucideIcon } from "lucide-react";
import { signOut } from "@/app/(auth)/actions";
import { setLocale } from "@/app/actions";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { sections } from "@/lib/nav";
import { goKeys } from "@/lib/shortcuts";

// The command menu (Cmd/Ctrl+K): jump to a section, switch appearance or language, show shortcuts, sign out.
// Searching leads joins it when leads exist (Day 3).
export function CommandPalette({
  open,
  onOpenChange,
  onShowShortcuts,
  isAdmin = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShowShortcuts: () => void;
  isAdmin?: boolean;
}) {
  const t = useTranslations("Palette");
  const nav = useTranslations("Nav");
  const router = useRouter();
  const locale = useLocale();
  const { setTheme } = useTheme();
  const [, startTransition] = useTransition();
  // Every opening starts with an empty search, also when it reopens while the last one is still fading out (the
  // content is then still mounted). Adjusted during render when `open` changes (React's pattern, no effect).
  const [search, setSearch] = useState("");
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setSearch("");
  }

  const run = (action: () => void) => {
    onOpenChange(false);
    action();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle className="sr-only">{t("title")}</DialogTitle>
        <DialogDescription className="sr-only">{t("description")}</DialogDescription>
        {/* vimBindings off: cmdk would take Ctrl+K as "previous item" and swallow it, so Ctrl+K could not close the menu. */}
        <Command label={t("title")} loop vimBindings={false} className="flex flex-col">
          <div className="flex items-center gap-3 border-b border-border px-4 focus-within:border-foreground/40">
            <Search aria-hidden="true" strokeWidth={1.75} className="size-5 shrink-0 text-muted-foreground" />
            <Command.Input
              value={search}
              onValueChange={setSearch}
              placeholder={t("placeholder")}
              autoComplete="off"
              spellCheck={false}
              className="h-14 min-w-0 flex-1 bg-transparent text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none"
            />
          </div>
          <Command.List className="max-h-[min(60vh,420px)] overflow-y-auto overscroll-contain p-2">
            <Command.Empty className="px-3 py-6 text-center text-muted-foreground">{t("empty")}</Command.Empty>

            <Group heading={t("goTo")}>
              {sections.map((s) => (
                <Item
                  key={s.id}
                  value={`go ${s.id} ${nav(s.id)}`}
                  icon={s.icon}
                  label={nav(s.id)}
                  keys={["G", goKeys[s.id].toUpperCase()]}
                  onSelect={() => run(() => router.push(s.href))}
                />
              ))}
            </Group>

            <Group heading={t("actions")}>
              <Item
                value="stock movements inventory log history mouvements"
                icon={History}
                label={t("stockMovements")}
                onSelect={() => run(() => router.push("/inventory?tab=movements"))}
              />
              <Item
                value="record sale sell order vente enregistrer vendre"
                icon={Receipt}
                label={t("recordSale")}
                onSelect={() => run(() => router.push("/inventory?tab=sales&record=1"))}
              />
              <Item
                value="stock requests client wants demandes de stock"
                icon={Inbox}
                label={t("stockRequests")}
                onSelect={() => run(() => router.push("/inventory?tab=requests"))}
              />
              <Item
                value="what clients see client view share link stock page ce que voient les clients lien client"
                icon={Eye}
                label={t("clientView")}
                onSelect={() => run(() => router.push("/inventory/client-view"))}
              />
              {isAdmin ? (
                <>
                  <Item
                    value="import leads csv spreadsheet importer prospects"
                    icon={Upload}
                    label={t("importLeads")}
                    onSelect={() => run(() => router.push("/leads/import"))}
                  />
                  <Item
                    value="import stock sheet csv inventory feuille de stock importer"
                    icon={Upload}
                    label={t("importStock")}
                    onSelect={() => run(() => router.push("/inventory/import"))}
                  />
                  <Item
                    value="inventory settings warehouse hold days restock reglages stock"
                    icon={Settings}
                    label={t("inventorySettings")}
                    onSelect={() => run(() => router.push("/inventory/settings"))}
                  />
                </>
              ) : null}
            </Group>

            <Group heading={t("appearance")}>
              <Item value="theme light" icon={Sun} label={t("themeLight")} onSelect={() => run(() => setTheme("light"))} />
              <Item value="theme dark" icon={Moon} label={t("themeDark")} onSelect={() => run(() => setTheme("dark"))} />
              <Item value="theme system" icon={Monitor} label={t("themeSystem")} onSelect={() => run(() => setTheme("system"))} />
            </Group>

            <Group heading={t("language")}>
              {(["en", "fr"] as const)
                .filter((l) => l !== locale)
                .map((l) => (
                  <Item
                    key={l}
                    value={`language ${l}`}
                    icon={Languages}
                    // Each language is named in itself, so it can be found from either interface language.
                    label={l === "en" ? "English" : "Français"}
                    lang={l}
                    onSelect={() =>
                      run(() =>
                        startTransition(async () => {
                          await setLocale(l);
                          router.refresh();
                        }),
                      )
                    }
                  />
                ))}
            </Group>

            <Group heading={t("help")}>
              <Item value="shortcuts keyboard help" icon={Keyboard} label={t("shortcuts")} keys={["?"]} onSelect={() => run(onShowShortcuts)} />
              <Item
                value="sign out logout"
                icon={LogOut}
                label={t("signOut")}
                onSelect={() => run(() => startTransition(() => signOut()))}
              />
            </Group>
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function Group({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <Command.Group
      heading={heading}
      className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-bold [&_[cmdk-group-heading]]:text-muted-foreground"
    >
      {children}
    </Command.Group>
  );
}

function Item({
  value,
  icon: Icon,
  label,
  keys,
  lang,
  onSelect,
}: {
  value: string;
  icon: LucideIcon;
  label: string;
  keys?: string[];
  lang?: string;
  onSelect: () => void;
}) {
  return (
    <Command.Item
      value={value}
      // The visible label is searchable too, so French words ("sombre", "déconnecter") find French items.
      keywords={[label]}
      onSelect={onSelect}
      className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-3 text-foreground data-[selected=true]:bg-muted"
    >
      <Icon aria-hidden="true" strokeWidth={1.75} className="size-5 shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate" lang={lang}>
        {label}
      </span>
      {keys ? (
        <span aria-hidden="true" className="flex gap-1">
          {keys.map((k) => (
            <Kbd key={k}>{k}</Kbd>
          ))}
        </span>
      ) : null}
    </Command.Item>
  );
}
