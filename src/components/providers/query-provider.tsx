"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { z } from "zod";

// Zod 4 checks once whether it may generate code, by calling Function(""). Our CSP has no 'unsafe-eval', so the browser
// blocks that call and reports a CSP violation (Zod then validates without generated code anyway). jitless skips the
// check: same results, nothing reported. Set here, before the signed-in app's first parse in the browser.
z.config({ jitless: true });

// One query cache per browser tab (never shared between requests on the server).
export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, gcTime: 5 * 60_000, retry: 1, refetchOnWindowFocus: false },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
