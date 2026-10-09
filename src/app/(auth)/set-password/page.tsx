import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AuthCard } from "@/components/auth/auth-card";
import { SetPasswordForm } from "@/components/auth/forms";
import { getGate } from "@/lib/auth";

export default async function SetPasswordPage() {
  const { gate, claims } = await getGate();
  if (gate === "signed-out") redirect("/login");
  // An existing authenticator must be passed before the password can change.
  if (gate === "needs-verify") redirect("/mfa?next=/set-password");
  const t = await getTranslations("Auth");
  return (
    <AuthCard title={t("setPasswordTitle")} body={t("setPasswordBody")}>
      <SetPasswordForm email={typeof claims?.email === "string" ? claims.email : ""} />
    </AuthCard>
  );
}
