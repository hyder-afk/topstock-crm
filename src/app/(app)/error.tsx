"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

// A page in the signed-in app failed: the top bar and dock stay, the page area says so plainly and offers a retry.
// retry() re-fetches the server data and re-renders (Next 16). No raw errors to users. A div, not a main: the shell
// layout already provides <main>.
export default function AppError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const t = useTranslations("Error");
  return (
    <div role="alert" className="flex max-w-xl flex-col items-start gap-4 pt-4">
      <h1 className="text-3xl font-bold sm:text-4xl">{t("title")}</h1>
      <p className="text-muted-foreground">{t("body")}</p>
      <Button onClick={retry}>{t("retry")}</Button>
    </div>
  );
}
