import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { buttonVariants } from "@/components/ui/button";
import { requireSession } from "@/lib/auth";

// Where opening a file ends when it cannot be opened (Day 4 design 5.7): gone, not ready, not this person's to open, or
// refused by the check on open. One answer for all, so it says nothing about which. Same shape as the app's not-found.
export default async function FileUnavailable() {
  await requireSession();
  const t = await getTranslations("Files.unavailable");
  return (
    <div className="flex max-w-xl flex-col items-start gap-4 pt-4">
      <h1 className="text-3xl font-bold text-balance sm:text-4xl">{t("title")}</h1>
      <p className="text-muted-foreground">{t("body")}</p>
      <Link href="/leads" className={buttonVariants({ variant: "neutral" })}>
        {t("back")}
      </Link>
    </div>
  );
}
