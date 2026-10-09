"use client";

import { useTranslations } from "next-intl";

// No raw errors to users: a plain message and a way to try again.
export default function ErrorPage({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const t = useTranslations("Error");
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-4 px-4">
      <h1 className="text-3xl font-bold">{t("title")}</h1>
      <p className="text-muted-foreground">{t("body")}</p>
      <button
        type="button"
        onClick={retry}
        className="w-fit rounded-md bg-brand px-4 py-2 font-bold text-brand-foreground transition-[filter,transform] duration-150 hover:brightness-105 active:scale-[0.97]"
      >
        {t("retry")}
      </button>
    </main>
  );
}
