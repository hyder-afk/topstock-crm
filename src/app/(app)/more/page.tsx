import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ChevronRight } from "lucide-react";
import { signOut } from "@/app/(auth)/actions";
import { SettingsBar } from "@/components/settings-bar";
import { ProfileForm } from "@/components/shell/profile-form";
import { Button } from "@/components/ui/button";
import { requireSession } from "@/lib/auth";
import { publicEnv } from "@/lib/env";
import { sections } from "@/lib/nav";

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

// More: the sections that do not fit the phone dock, settings, status and sign-out.
export default async function MorePage() {
  const { supabase, claims } = await requireSession();
  const [t, nav, profileT, up, profile] = await Promise.all([
    getTranslations("More"),
    getTranslations("Nav"),
    getTranslations("Profile"),
    databaseReachable(),
    supabase.from("profiles").select("first_name, last_name").eq("id", claims.sub).maybeSingle(),
  ]);
  const phoneOnly = sections.filter((s) => !s.phone);
  return (
    <div className="flex flex-col gap-8 pt-4">
      <h1 className="text-3xl font-bold sm:text-4xl">{nav("more")}</h1>

      <section aria-labelledby="more-sections" className="flex flex-col gap-3 lg:hidden">
        <h2 id="more-sections" className="text-lg font-bold">
          {t("sections")}
        </h2>
        <ul className="flex flex-col overflow-hidden rounded-lg bg-card">
          {phoneOnly.map((s) => {
            const Icon = s.icon;
            return (
              <li key={s.id} className="border-b border-border last:border-b-0">
                <Link
                  href={s.href}
                  className="flex min-h-14 items-center gap-3 px-4 transition-colors duration-150 hover:bg-muted active:bg-muted"
                >
                  <Icon aria-hidden="true" strokeWidth={1.75} className="size-[22px] text-muted-foreground" />
                  <span className="flex-1">{nav(s.id)}</span>
                  <ChevronRight aria-hidden="true" strokeWidth={1.75} className="size-5 text-muted-foreground" />
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      <section id="profile" aria-labelledby="more-profile" className="flex scroll-mt-6 flex-col gap-3">
        <h2 id="more-profile" className="text-lg font-bold">
          {profileT("title")}
        </h2>
        <div className="rounded-lg bg-card p-4 sm:p-6">
          <ProfileForm firstName={profile.data?.first_name ?? ""} lastName={profile.data?.last_name ?? ""} />
        </div>
      </section>

      <section aria-labelledby="more-settings" className="flex flex-col gap-3">
        <h2 id="more-settings" className="text-lg font-bold">
          {t("settings")}
        </h2>
        <div className="flex flex-col gap-4 rounded-lg bg-card p-4 sm:p-6">
          <SettingsBar />
        </div>
      </section>

      <section aria-labelledby="more-status" className="flex flex-col gap-3">
        <h2 id="more-status" className="text-lg font-bold">
          {t("status")}
        </h2>
        <p className="inline-flex items-center gap-2 rounded-lg bg-card p-4 font-mono text-sm sm:p-6">
          <span aria-hidden="true" className={up ? "size-2 rounded-full bg-status-green" : "size-2 rounded-full bg-status-red"} />
          {up ? t("statusUp") : t("statusDown")}
        </p>
      </section>

      <form action={signOut}>
        <Button type="submit" variant="quiet">
          {t("signOut")}
        </Button>
      </form>
    </div>
  );
}
