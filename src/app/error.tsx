"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

// No raw errors to users: a plain message and a way to try again.
export default function ErrorPage({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const t = useTranslations("Error");
  return (
    <main id="main" className="mx-auto flex min-h-safe-screen max-w-xl flex-col justify-center gap-4 px-4">
      <h1 className="text-3xl font-bold">{t("title")}</h1>
      <p className="text-muted-foreground">{t("body")}</p>
      <Button onClick={retry} className="w-fit">
        {t("retry")}
      </Button>
    </main>
  );
}
