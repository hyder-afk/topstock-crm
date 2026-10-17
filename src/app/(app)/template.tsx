"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

// Re-mounts on every navigation inside the app. The first visit to each page in this tab enters with a short fade and
// 8 px rise; coming back shows the page at rest (DESIGN.md: entrances on first visit only). Module state, one per tab
// like the greeting's: the server render and first hydration carry the class, so content is visible without JavaScript
// and a full reload starts fresh. CSS only, opacity and transform, never blocks input; reduced motion turns it off.
const seen = new Set<string>();

export default function Template({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [play] = useState(() => !seen.has(pathname));
  useEffect(() => {
    seen.add(pathname);
  }, [pathname]);
  return <div className={play ? "animate-page flex flex-1 flex-col" : "flex flex-1 flex-col"}>{children}</div>;
}
