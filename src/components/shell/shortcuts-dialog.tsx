"use client";

import { useRef } from "react";
import { useTranslations } from "next-intl";
import { X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { sections } from "@/lib/nav";
import { goKeys } from "@/lib/shortcuts";
import { useModKey } from "@/lib/use-platform";

// "?" shows every shortcut. Rows are a definition list: keys, then what they do.
export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations("Shortcuts");
  const nav = useTranslations("Nav");
  const mod = useModKey() ?? "Ctrl";
  const panel = useRef<HTMLDivElement>(null);
  const rows: { keys: string[]; label: string }[] = [
    { keys: [mod, "K"], label: t("palette") },
    { keys: ["/"], label: t("search") },
    { keys: ["?"], label: t("help") },
    ...sections.map((s) => ({ keys: ["G", goKeys[s.id].toUpperCase()], label: t("goTo", { section: nav(s.id) }) })),
  ];
  // Day 4b: the lead page, the leads preview and the call panel.
  const leadRows: { keys: string[]; label: string }[] = [
    { keys: ["J", "K"], label: t("nextLead") },
    { keys: ["O"], label: t("openLead") },
    { keys: ["1–7", "0"], label: t("outcomeKeys") },
    { keys: ["U"], label: t("undoLast") },
    { keys: [mod, "↩"], label: t("saveEntry") },
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* A read-only list: focus starts on the panel, not on the close button (WAI-ARIA dialog pattern). Tab reaches
          Close, Escape closes. */}
      <DialogContent
        ref={panel}
        className="max-h-[calc(100dvh-24vh)] overflow-y-auto p-6"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          panel.current?.focus();
        }}
      >
        <DialogClose
          aria-label={t("close")}
          className="absolute top-3 right-3 grid size-11 place-items-center rounded-md text-muted-foreground transition-[color,transform] duration-150 hover:text-foreground active:scale-[0.97]"
        >
          <X aria-hidden="true" strokeWidth={1.75} className="size-5" />
        </DialogClose>
        <DialogTitle className="pr-12 text-xl font-bold">{t("title")}</DialogTitle>
        <DialogDescription className="mt-1 text-sm text-muted-foreground">{t("description")}</DialogDescription>
        <dl className="mt-4 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2">
          {rows.map((r) => (
            <div key={r.label} className="contents">
              <dt className="flex gap-1">
                {r.keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </dt>
              <dd>{r.label}</dd>
            </div>
          ))}
        </dl>
        <h3 className="mt-5 text-sm font-bold text-muted-foreground">{t("leadPage")}</h3>
        <dl className="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2">
          {leadRows.map((r) => (
            <div key={r.label} className="contents">
              <dt className="flex gap-1">
                {r.keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </dt>
              <dd>{r.label}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
