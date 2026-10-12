import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { buttonVariants } from "@/components/ui/button";

// A lead that does not exist or is not visible to this person (and a malformed id): the app's not-found answer, the
// same for all three, with the way back to the leads list (Day 4 design 7.1).
export default async function LeadNotFound() {
  const t = await getTranslations("NotFound");
  return (
    <div className="flex max-w-xl flex-col items-start gap-4 pt-4">
      <h1 className="text-3xl font-bold sm:text-4xl">{t("title")}</h1>
      <p className="text-muted-foreground">{t("body")}</p>
      <Link href="/leads" className={buttonVariants({ variant: "neutral" })}>
        {t("backToLeads")}
      </Link>
    </div>
  );
}
