import { getTranslations } from "next-intl/server";
import { AuthCardSkeleton } from "@/components/auth/auth-card";

export default async function Loading() {
  const t = await getTranslations("Common");
  return <AuthCardSkeleton label={t("loading")} fields={2} />;
}
