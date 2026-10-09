import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AuthCard } from "@/components/auth/auth-card";
import { SignOutButton, TotpSetup } from "@/components/auth/forms";
import { getGate } from "@/lib/auth";

// The enrolment wall: nobody reaches the app without an authenticator.
export default async function MfaSetupPage() {
  const { gate } = await getGate();
  if (gate === "signed-out") redirect("/login");
  if (gate === "needs-verify") redirect("/mfa");
  if (gate === "ok") redirect("/");
  const t = await getTranslations("Auth");
  return (
    <AuthCard title={t("setupTitle")} body={t("setupBody")}>
      <TotpSetup />
      <SignOutButton />
    </AuthCard>
  );
}
