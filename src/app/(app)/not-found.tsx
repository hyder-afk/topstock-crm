import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { buttonVariants } from "@/components/ui/button";

// A page in the signed-in app that does not exist, or that this person may not open (an import page for a rep): the
// same plain answer either way, so it says nothing about what is there. The shell stays; a div, not a main.
export default async function AppNotFound() {
  const t = await getTranslations("NotFound");
  return (
    <div className="flex max-w-xl flex-col items-start gap-4 pt-4">
      <h1 className="text-3xl font-bold sm:text-4xl">{t("title")}</h1>
      <p className="text-muted-foreground">{t("body")}</p>
      <Link href="/" className={buttonVariants({ variant: "neutral" })}>
        {t("home")}
      </Link>
    </div>
  );
}
