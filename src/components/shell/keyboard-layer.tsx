"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CommandPalette } from "@/components/shell/command-palette";
import { ShortcutsDialog } from "@/components/shell/shortcuts-dialog";
import { sections } from "@/lib/nav";
import { goKeys, isTyping } from "@/lib/shortcuts";

type Shell = { openPalette: () => void; openShortcuts: () => void };
const ShellContext = createContext<Shell>({ openPalette: () => {}, openShortcuts: () => {} });
export const useShell = () => useContext(ShellContext);

// Keyboard-first layer for the signed-in app: Cmd/Ctrl+K and "/" open the command menu, "?" lists the shortcuts,
// "G" then a letter opens a section. Single keys stay quiet while the person is typing in a field.
export function KeyboardLayer({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const pendingG = useRef<number | null>(null);

  const openPalette = useCallback(() => {
    setHelp(false);
    setPalette(true);
  }, []);
  const openShortcuts = useCallback(() => {
    setPalette(false);
    setHelp(true);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const key = event.key.toLowerCase();
      if (key === "k" && (event.metaKey || event.ctrlKey) && !event.altKey) {
        event.preventDefault();
        setHelp(false);
        setPalette((open) => !open);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (document.querySelector("[role=dialog]")) return; // an open dialog owns the keyboard

      if (pendingG.current !== null) {
        window.clearTimeout(pendingG.current);
        pendingG.current = null;
        const section = sections.find((s) => goKeys[s.id] === key);
        if (section) {
          event.preventDefault();
          router.push(section.href);
        }
        return;
      }
      if (key === "g" && !event.shiftKey) {
        pendingG.current = window.setTimeout(() => (pendingG.current = null), 1200);
      } else if (event.key === "?") {
        event.preventDefault();
        openShortcuts();
      } else if (event.key === "/") {
        event.preventDefault();
        openPalette();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (pendingG.current !== null) window.clearTimeout(pendingG.current);
    };
  }, [router, openPalette, openShortcuts]);

  const value = useMemo(() => ({ openPalette, openShortcuts }), [openPalette, openShortcuts]);
  return (
    <ShellContext.Provider value={value}>
      {children}
      <CommandPalette open={palette} onOpenChange={setPalette} onShowShortcuts={openShortcuts} />
      <ShortcutsDialog open={help} onOpenChange={setHelp} />
    </ShellContext.Provider>
  );
}
