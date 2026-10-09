import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AuthCard } from "@/components/auth/auth-card";
import { LoginForm } from "@/components/auth/forms";
import { gatePath, getGate } from "@/lib/auth";

export default async function LoginPage() {
  const { gate } = await getGate();
  if (gate === "ok") redirect("/");
  if (gate !== "signed-out") redirect(gatePath[gate]);
  const t = await getTranslations("Auth");
  return (
    <AuthCard title={t("signInTitle")} body={t("signInBody")}>
      <LoginForm />
    </AuthCard>
  );
}
