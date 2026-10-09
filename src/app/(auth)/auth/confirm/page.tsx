import { getTranslations } from "next-intl/server";
import { AuthCard } from "@/components/auth/auth-card";
import { ConfirmLinkForm } from "@/components/auth/forms";

// Landing page for invite and password-reset emails. The token is only used when the person presses Continue.
export default async function ConfirmPage({ searchParams }: PageProps<"/auth/confirm">) {
  const t = await getTranslations("Auth");
  const sp = await searchParams;
  const tokenHash = typeof sp.token_hash === "string" ? sp.token_hash.slice(0, 512) : "";
  const type = sp.type === "invite" || sp.type === "recovery" ? sp.type : "";
  if (!tokenHash || !type) {
    return <AuthCard title={t("confirmTitle")} body={t("errors.linkInvalid")}>{null}</AuthCard>;
  }
  return (
    <AuthCard title={t("confirmTitle")} body={type === "invite" ? t("confirmInviteBody") : t("confirmRecoveryBody")}>
      <ConfirmLinkForm tokenHash={tokenHash} type={type} />
    </AuthCard>
  );
}
