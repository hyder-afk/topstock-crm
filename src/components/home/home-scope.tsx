"use client";

import { createContext, startTransition, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { rememberScope, rememberedScope } from "@/components/home/use-home";
import type { HomeData, HomeScope } from "@/lib/home";
import { cn } from "@/lib/utils";

// Home's scope (Day 5 design 7.10, D28): managers and admins see the Team by default and may switch to Mine; reps see
// Mine and get no switch. The choice is remembered on this device (a cookie the server reads, so a reload renders the
// remembered scope at once). The provider sits above the page's Suspense boundary, so the greeting and the switch are
// on screen while the cards stream.

type HomeContextValue = {
  /** The scope chosen on the switch (pressed at once). */
  scope: HomeScope;
  /** The scope the cards render: the server's until the cards have mounted, then the chosen one. */
  viewScope: HomeScope;
  /** Called by the cards once they have mounted (hydrated). */
  cardsMounted: () => void;
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
  // The cards stream in under the page's Suspense boundary. A tap on the switch before their HTML has arrived and
  // hydrated would make React hydrate them inside the switch's render, with the new scope: the client's first render
  // (no data for that scope yet: skeletons) would not match the server's HTML (cards for the server's scope), React
  // would throw that HTML away (hydration error #418). So the cards render the server's scope until they have mounted,
  // then the chosen one; the switch itself shows the choice at once.
  const [cardsReady, setCardsReady] = useState(false);
  const cardsMounted = useCallback(() => setCardsReady(true), []);
  const viewScope = cardsReady ? scope : initialScope;
  // The device remembers what this person sees, so the dock's prefetch warms the right scope next time.
  useEffect(() => {
    if (rememberedScope() !== initialScope) rememberScope(initialScope);
  }, [initialScope]);
  const setScope = useCallback(
    (s: HomeScope) => {
      if (!canSwitch) return;
      // A transition: the cards' new figures may suspend without hiding what is on screen.
      startTransition(() => setScopeState(s));
      rememberScope(s);
    },
    [canSwitch],
  );
  const initial = useMemo(() => ({ scope: initialScope, promise }), [initialScope, promise]);
  const value = useMemo(
    () => ({ scope, viewScope, cardsMounted, setScope, canSwitch, initial }),
    [scope, viewScope, cardsMounted, setScope, canSwitch, initial],
  );
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
