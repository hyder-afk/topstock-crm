import { getTranslations } from "next-intl/server";
import { Logo } from "@/components/logo";
import { SettingsBar } from "@/components/settings-bar";
import { publicEnv } from "@/lib/env";

// Live check against the Supabase auth health endpoint (public key only, no user data).
async function databaseReachable() {
  try {
    const res = await fetch(`${publicEnv.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/health`, {
      headers: { apikey: publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY },
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Day 1 placeholder: proves the brand, themes, languages and fonts. Features start on Day 2.
export default async function Home() {
  const [t, up] = await Promise.all([getTranslations("Home"), databaseReachable()]);
  return (
    <main id="main" className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-10 px-4 py-8 sm:px-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <Logo className="h-auto w-[184px] text-foreground" />
        <SettingsBar />
      </header>
      <section className="flex flex-col gap-4 rounded-lg bg-card p-6 sm:p-8">
        <p className="text-muted-foreground">{t("greeting")}</p>
        <h1 className="text-4xl font-bold sm:text-5xl">{t("title")}</h1>
        <p className="max-w-[60ch] text-lg text-muted-foreground">{t("body")}</p>
        <p className="inline-flex items-center gap-2 font-mono text-sm">
          <span aria-hidden="true" className={up ? "size-2 rounded-full bg-status-green" : "size-2 rounded-full bg-status-red"} />
          {up ? t("statusUp") : t("statusDown")}
        </p>
      </section>
      <p className="text-sm text-muted-foreground" translate="no">
        {t("tagline")}
      </p>
    </main>
  );
}
