import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AuthCard } from "@/components/auth/auth-card";
import { SignOutButton, VerifyTotpForm } from "@/components/auth/forms";
import { getGate, safeNext } from "@/lib/auth";

export default async function MfaPage({ searchParams }: PageProps<"/mfa">) {
  const next = safeNext((await searchParams).next);
  const { gate } = await getGate();
  if (gate === "signed-out") redirect("/login");
  if (gate === "needs-setup") redirect("/mfa/setup");
  if (gate === "ok") redirect(next);
  const t = await getTranslations("Auth");
  return (
    <AuthCard title={t("mfaTitle")} body={t("mfaBody")}>
      <VerifyTotpForm next={next} />
      <SignOutButton />
    </AuthCard>
  );
}
