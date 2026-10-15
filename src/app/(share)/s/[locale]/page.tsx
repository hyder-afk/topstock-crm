import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { SharePage } from "@/components/share/share-page";

// /s/fr and /s/en (design 8.6): the shell only. The stock arrives from /api/share/view once the page has read the token
// from the URL fragment, which never reaches this server.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Share.meta");
  return {
    title: t("title"),
    description: t("description"),
    robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
    referrer: "no-referrer",
  };
}

export default async function ShareRoute({ params }: PageProps<"/s/[locale]">) {
  const { locale } = await params;
  if (locale !== "fr" && locale !== "en") notFound();
  const t = await getTranslations("Share");
  return (
    <>
      <noscript>
        <p className="mx-auto max-w-[720px] px-4 pt-6">{t("noscript")}</p>
      </noscript>
      <SharePage />
    </>
  );
}
