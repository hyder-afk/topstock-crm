"use client";

import { useSyncExternalStore } from "react";

const noop = () => () => {};

// "⌘" on Apple devices, "Ctrl" elsewhere. null on the server and during hydration (the platform is unknown there).
export function useModKey(): string | null {
  return useSyncExternalStore(
    noop,
    () => (/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl"),
    () => null,
  );
}
