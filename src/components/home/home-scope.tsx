"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { rememberScope, rememberedScope } from "@/components/home/use-home";
import type { HomeData, HomeScope } from "@/lib/home";
import { cn } from "@/lib/utils";

// Home's scope (Day 5 design 7.10, D28): managers and admins see the Team by default and may switch to Mine; reps see
// Mine and get no switch. The choice is remembered on this device (a cookie the server reads, so a reload renders the
// remembered scope at once). The provider sits above the page's Suspense boundary, so the greeting and the switch are
// on screen while the cards stream.

type HomeContextValue = {
  scope: HomeScope;
  setScope: (s: HomeScope) => void;
  canSwitch: boolean;
  /** The server's first paint, for the scope it rendered (D32): read with use() only when the cache is empty. */
  initial: { scope: HomeScope; promise: Promise<HomeData | null> };
};

const HomeContext = createContext<HomeContextValue | null>(null);

export function useHomeScope(): HomeContextValue {
  const v = useContext(HomeContext);
  if (!v) throw new Error("useHomeScope outside HomeScopeProvider");
  return v;
}

export function HomeScopeProvider({
  initialScope,
  canSwitch,
  promise,
  children,
}: {
  initialScope: HomeScope;
  canSwitch: boolean;
  promise: Promise<HomeData | null>;
  children: React.ReactNode;
}) {
  const [scope, setScopeState] = useState<HomeScope>(initialScope);
  // The device remembers what this person sees, so the dock's prefetch warms the right scope next time.
  useEffect(() => {
    if (rememberedScope() !== initialScope) rememberScope(initialScope);
  }, [initialScope]);
  const setScope = useCallback(
    (s: HomeScope) => {
      if (!canSwitch) return;
      setScopeState(s);
      rememberScope(s);
    },
    [canSwitch],
  );
  const initial = useMemo(() => ({ scope: initialScope, promise }), [initialScope, promise]);
  const value = useMemo(() => ({ scope, setScope, canSwitch, initial }), [scope, setScope, canSwitch, initial]);
  return <HomeContext.Provider value={value}>{children}</HomeContext.Provider>;
}

/** Team · Mine, on the greeting's baseline (managers and admins only). */
export function HomeScopeSwitch() {
  const t = useTranslations("Home.scope");
  const { scope, setScope, canSwitch } = useHomeScope();
  if (!canSwitch) return null;
  return (
    <div role="group" aria-label={t("label")} className="inline-flex shrink-0 rounded-md bg-muted p-1">
      {(["team", "mine"] as const).map((s) => (
        <button
          key={s}
          type="button"
          aria-pressed={scope === s}
          onClick={() => setScope(s)}
          className={cn(
            "min-h-11 min-w-16 rounded-sm px-4 text-sm font-bold transition-[background-color,color,scale] duration-150 active:scale-[0.97] sm:min-h-9",
            scope === s ? "bg-pill text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t(s)}
        </button>
      ))}
    </div>
  );
}
