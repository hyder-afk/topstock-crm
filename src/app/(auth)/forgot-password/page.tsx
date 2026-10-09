import { getTranslations } from "next-intl/server";
import { AuthCard } from "@/components/auth/auth-card";
import { ForgotPasswordForm } from "@/components/auth/forms";

export default async function ForgotPasswordPage() {
  const t = await getTranslations("Auth");
  return (
    <AuthCard title={t("forgotTitle")} body={t("forgotBody")}>
      <ForgotPasswordForm />
    </AuthCard>
  );
}
