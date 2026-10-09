import { getTranslations } from "next-intl/server";
import { Logo } from "@/components/logo";
import { SettingsBar } from "@/components/settings-bar";
import { Button } from "@/components/ui/button";
import { signOut } from "@/app/(auth)/actions";
import { requireSession } from "@/lib/auth";
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

// Day 1 placeholder behind the sign-in wall: proves sign-in, two-factor, brand, themes and languages. Features start on Day 2.
export default async function Home() {
  const { supabase, claims } = await requireSession();
  const [t, up, profile] = await Promise.all([
    getTranslations("Home"),
    databaseReachable(),
    // RLS lets each person read profiles in their own org; this reads their own row only.
    supabase.from("profiles").select("first_name").eq("id", claims.sub).maybeSingle(),
  ]);
  const firstName = profile.data?.first_name?.trim();
  return (
    <main id="main" className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col gap-10 px-4 py-8 sm:px-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <Logo className="h-auto w-[184px] text-foreground" />
        <div className="flex flex-wrap items-center gap-3">
          <SettingsBar />
          <form action={signOut}>
            <Button type="submit" variant="quiet" className="min-h-11 text-sm sm:min-h-9">
              {t("signOut")}
            </Button>
          </form>
        </div>
      </header>
      <section className="flex flex-col gap-4 rounded-lg bg-card p-6 sm:p-8">
        <p className="text-muted-foreground">{firstName ? t("greetingName", { name: firstName }) : t("greeting")}</p>
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
