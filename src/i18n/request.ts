import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { defaultLocale, isLocale, localeCookie } from "./config";

// No locale in the URL: the choice lives in a cookie (internal app, three users).
export default getRequestConfig(async () => {
  const store = await cookies();
  const value = store.get(localeCookie)?.value;
  const locale = isLocale(value) ? value : defaultLocale;
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
    timeZone: "Europe/Paris",
    // One reference time per request for "2 days ago": the browser inherits it, so server and client agree.
    now: new Date(),
  };
});
