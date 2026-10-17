import Link from "next/link";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { ChevronLeft, UsersRound } from "lucide-react";
import { EmptyState } from "@/components/shell/empty-state";
import { RetryButton, TeamList } from "@/components/team/team-list";
import { requireAdmin, stepUpSecondsLeft } from "@/lib/auth";
import { roles, sortPeople, toPeople } from "@/lib/team";

// More > Team (go-live parts A and K): admins see the organisation's people and change their roles with a fresh code.
// Everyone else gets the standard 404, and the database refuses them too (public.set_user_role).
// The list reads public.profiles (row level security keeps it to the caller's organisation); profiles holds no email,
// so someone without a name yet is told apart by the start of their user id and the day their account was created.
// The whole organisation (a handful of people); sortPeople orders it. Plain select and filters only, so the local REST
// stand-in (scripts/local-auth) serves it as PostgREST does. `readAt` is the server's time just before the read: a role
// saved on the screen stays shown until a list read after the save arrives (compared with the time the action returns,
// on the same clock).
async function readPeople(supabase: Awaited<ReturnType<typeof requireAdmin>>["supabase"]) {
  const readAt = Date.now();
  const result = await supabase.from("profiles").select("id, first_name, last_name, role, created_at");
  return { result, readAt };
}

export default async function TeamPage() {
  const { supabase, claims, timezone } = await requireAdmin();
  const [t, format, locale, { result, readAt }] = await Promise.all([
    getTranslations("Team"),
    getFormatter(),
    getLocale(),
    readPeople(supabase),
  ]);
  const people = result.error ? null : toPeople(result.data);
  const sorted = people ? sortPeople(people, claims.sub, locale) : null;
  // Dates are written here, once, so the server's and the browser's date data can never disagree after loading.
  const created = Object.fromEntries(
    (sorted ?? []).map((p) => [p.id, format.dateTime(new Date(p.createdAt), { day: "numeric", month: "short", year: "numeric", timeZone: timezone })]),
  );

  return (
    <div className="flex flex-col gap-8 pt-4">
      <div className="flex flex-col gap-2">
        <Link
          href="/more"
          className="-ml-1 inline-flex min-h-11 w-fit items-center gap-1 rounded-md pr-2 text-muted-foreground transition-colors duration-150 hover:text-foreground active:opacity-60"
        >
          <ChevronLeft aria-hidden="true" strokeWidth={1.75} className="size-5" />
          {t("back")}
        </Link>
        <h1 id="team-title" tabIndex={-1} className="text-3xl font-bold tracking-[-0.03em] outline-none sm:text-4xl">{t("title")}</h1>
        <p className="max-w-[65ch] text-muted-foreground">{t("subtitle")}</p>
      </div>

      {sorted === null ? (
        <div role="alert" className="flex flex-col items-start gap-3 rounded-lg bg-card p-6 sm:p-8">
          <p className="font-bold">{t("errors.load")}</p>
          <RetryButton label={t("errors.retry")} />
        </div>
      ) : sorted.length === 0 ? (
        <EmptyState icon={UsersRound} title={t("empty.title")} body={t("empty.body")} />
      ) : (
        <TeamList people={sorted} readAt={readAt} created={created} me={claims.sub} stepUpSeconds={stepUpSecondsLeft(claims)} />
      )}

      <section aria-labelledby="team-roles" className="flex flex-col gap-3">
        <h2 id="team-roles" className="text-lg font-bold">
          {t("rolesTitle")}
        </h2>
        <dl className="grid gap-4 rounded-lg bg-card p-4 sm:p-6 md:grid-cols-3">
          {roles.map((r) => (
            <div key={r} className="flex flex-col gap-1">
              <dt className="font-bold">{t(`role.${r}`)}</dt>
              <dd className="text-sm text-muted-foreground">{t(`roleDescription.${r}`)}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
