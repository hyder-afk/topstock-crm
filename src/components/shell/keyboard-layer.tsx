"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CommandPalette } from "@/components/shell/command-palette";
import { ShortcutsDialog } from "@/components/shell/shortcuts-dialog";
import { sections } from "@/lib/nav";
import { goKeys, isTyping, queueGoKey } from "@/lib/shortcuts";

// isChordPending (Day 5b, design 7.7): element key handlers run before this layer's window handler, so a focused deal
// card asks whether a "G then a letter" chord is under way before it takes a key for itself.
type Shell = { openPalette: () => void; openShortcuts: () => void; isChordPending: () => boolean };
const ShellContext = createContext<Shell>({ openPalette: () => {}, openShortcuts: () => {}, isChordPending: () => false });
export const useShell = () => useContext(ShellContext);

// Keyboard-first layer for the signed-in app: Cmd/Ctrl+K and "/" open the command menu, "?" lists the shortcuts,
// "G" then a letter opens a section. Single keys stay quiet while the person is typing in a field.
export function KeyboardLayer({ children, isAdmin = false }: { children: React.ReactNode; isAdmin?: boolean }) {
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
      // isComposing: an accent or IME sequence is in progress (e.g. dead keys on a French keyboard), not a shortcut.
      if (event.defaultPrevented || event.isComposing) return;
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
        } else if (key === queueGoKey) {
          // G then Q: the work queue (Day 4c; the dock bead stays on Leads).
          event.preventDefault();
          router.push("/leads/queue");
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

  const isChordPending = useCallback(() => pendingG.current !== null, []);
  const value = useMemo(() => ({ openPalette, openShortcuts, isChordPending }), [openPalette, openShortcuts, isChordPending]);
  return (
    <ShellContext.Provider value={value}>
      {children}
      <CommandPalette open={palette} onOpenChange={setPalette} onShowShortcuts={openShortcuts} isAdmin={isAdmin} />
      <ShortcutsDialog open={help} onOpenChange={setHelp} />
    </ShellContext.Provider>
  );
}
