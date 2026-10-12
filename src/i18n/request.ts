import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { defaultLocale, isLocale, localeCookie } from "./config";
import { isShareSurface, shareMessages } from "./share-messages";

// No locale in the URL: the choice lives in a cookie (internal app, three users). The client stock page (/s/fr, /s/en)
// is the exception: the proxy names the surface and the locale from the path, the cookie is ignored and only the
// Share messages are loaded (design 8.6).
export default getRequestConfig(async () => {
  const h = await headers();
  if (isShareSurface(h.get("x-topstock-surface"))) {
    const value = h.get("x-topstock-locale") ?? undefined;
    const locale = isLocale(value) ? value : defaultLocale;
    return {
      locale,
      messages: shareMessages((await import(`../../messages/${locale}.json`)).default),
      timeZone: "Europe/Paris",
      now: new Date(),
    };
  }
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
