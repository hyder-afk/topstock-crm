import "server-only";
import { cookies, headers } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { publicEnv } from "@/lib/env";
import { authCookieOptions, isHttps } from "@/lib/supabase/cookie-options";

// A fresh client per request; never share one across requests.
export async function createClient() {
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()]);
  return createServerClient(publicEnv.NEXT_PUBLIC_SUPABASE_URL, publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookieOptions: authCookieOptions(isHttps(null, headerList.get("x-forwarded-proto"))),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component, where cookies are read-only; the proxy refreshes the session instead.
        }
      },
    },
  });
}
