"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import type { AuthError } from "@supabase/supabase-js";
import { gatePath, getGate, requireSession, safeNext } from "@/lib/auth";
import { recordAuthEvent } from "@/lib/auth-events";
import { createClient } from "@/lib/supabase/server";

// Every action validates its input with Zod and answers with a short code; the screens turn codes into EN/FR text.
// Raw auth errors never reach the browser, and no answer reveals whether an email address has an account.

export type FormState = { error?: string; done?: boolean; email?: string } | undefined;

const email = z.email().max(254);
const code = z.string().regex(/^\d{6}$/);
// Mirrors supabase/config.toml: 12+ characters with lower, upper, digit and symbol. 72 is the bcrypt limit.
const newPassword = z
  .string()
  .min(12)
  .max(72)
  .regex(/[a-z]/)
  .regex(/[A-Z]/)
  .regex(/\d/)
  .regex(/[^A-Za-z0-9]/);

function isRateLimited(error: AuthError) {
  return error.status === 429 || error.code === "over_request_rate_limit";
}

async function continueAfterPassword(): Promise<never> {
  const { gate } = await getGate();
  redirect(gate === "ok" ? "/" : gatePath[gate]);
}

export async function signIn(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = z
    .object({ email, password: z.string().min(1).max(256) })
    .safeParse({ email: formData.get("email"), password: formData.get("password") });
  const typedEmail = String(formData.get("email") ?? "").slice(0, 254);
  if (!parsed.success) return { error: "invalidCredentials", email: typedEmail };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    if (isRateLimited(error)) return { error: "rateLimited", email: typedEmail };
    if (error.status && error.status < 500) return { error: "invalidCredentials", email: typedEmail };
    return { error: "unavailable", email: typedEmail };
  }
  return continueAfterPassword();
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "local" });
  redirect("/login");
}

export type SignOutEverywhereResult = { error: "unavailable" | "rateLimited" } | undefined;

// "Sign out of all devices" (Gate 1 item 25): ends every session of this person (scope "global": the auth server
// revokes all their refresh tokens), then this browser's cookies go too. Only for a fully signed-in (aal2) person,
// checked on the server; no fresh code, because it only takes access away and is what someone does when a device is
// lost (Master Plan section 8 lists step-up for adjustments, imports, exports, deletes and role changes). On failure
// the person stays signed in here and sees a short message; nothing raw reaches the browser.
export async function signOutEverywhere(): Promise<SignOutEverywhereResult> {
  const { supabase } = await requireSession();
  const { error } = await supabase.auth.signOut({ scope: "global" });
  if (error) return { error: isRateLimited(error) ? "rateLimited" : "unavailable" };
  redirect("/login");
}

export async function requestPasswordReset(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = email.safeParse(formData.get("email"));
  if (!parsed.success) return { error: "invalidEmail" };
  const supabase = await createClient();
  // The email template builds the link from the site URL and a one-time token hash (supabase/templates/recovery.html).
  // Same answer whether or not the address exists, and whatever the auth server says.
  await supabase.auth.resetPasswordForEmail(parsed.data);
  return { done: true };
}

const otpType = z.enum(["invite", "recovery"]);

// Called from the "Continue" button on /auth/confirm, never from the link itself, so mail scanners that open links
// cannot use up the one-time token.
export async function confirmEmailLink(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = z
    .object({ token_hash: z.string().min(1).max(512), type: otpType })
    .safeParse({ token_hash: formData.get("token_hash"), type: formData.get("type") });
  if (!parsed.success) return { error: "linkInvalid" };
  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp(parsed.data);
  if (error) return { error: isRateLimited(error) ? "rateLimited" : "linkInvalid" };
  redirect("/set-password");
}

export async function setPassword(_prev: FormState, formData: FormData): Promise<FormState> {
  const password = formData.get("password");
  if (password !== formData.get("confirm")) return { error: "passwordMismatch" };
  const parsed = newPassword.safeParse(password);
  if (!parsed.success) return { error: "passwordWeak" };

  const { gate, supabase } = await getGate();
  if (gate === "signed-out") redirect("/login");
  // Someone with an authenticator must pass it before changing the password.
  if (gate === "needs-verify") redirect("/mfa?next=/set-password");

  const { error } = await supabase.auth.updateUser({ password: parsed.data });
  if (error) {
    if (error.code === "weak_password") return { error: "passwordWeak" };
    if (error.code === "same_password") return { error: "passwordSame" };
    if (error.code === "insufficient_aal") redirect("/mfa?next=/set-password");
    if (isRateLimited(error)) return { error: "rateLimited" };
    return { error: "unavailable" };
  }
  return continueAfterPassword();
}

export type EnrollState =
  | { error?: string; factorId?: undefined }
  | { error?: undefined; factorId: string; qr: string; secret: string }
  | undefined;

// Starts authenticator setup. Only for a signed-in user who has no verified authenticator yet:
// adding a second one needs a full (aal2) sign-in, which this screen never has.
export async function startTotpEnrollment(): Promise<EnrollState> {
  const { gate, supabase } = await getGate();
  if (gate === "signed-out") redirect("/login");
  if (gate !== "needs-setup") redirect(gate === "ok" ? "/" : gatePath[gate]);

  // Clear half-finished attempts (unverified factors) so only one QR code is ever live.
  const { data: factors } = await supabase.auth.mfa.listFactors();
  for (const f of factors?.all ?? []) {
    if (f.factor_type === "totp" && f.status === "unverified") await supabase.auth.mfa.unenroll({ factorId: f.id });
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    issuer: "TopStock CRM",
    friendlyName: `TopStock ${new Date().toISOString()}`,
  });
  if (error || !data) return { error: error && isRateLimited(error) ? "rateLimited" : "unavailable" };
  const qr = data.totp.qr_code.startsWith("data:")
    ? data.totp.qr_code
    : `data:image/svg+xml;utf8,${encodeURIComponent(data.totp.qr_code)}`;
  return { factorId: data.id, qr, secret: data.totp.secret };
}

export async function verifyTotpEnrollment(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = z
    .object({ factorId: z.uuid(), code })
    .safeParse({ factorId: formData.get("factorId"), code: String(formData.get("code") ?? "").replace(/\s/g, "") });
  if (!parsed.success) return { error: "codeInvalid" };

  const { gate, supabase } = await getGate();
  if (gate === "signed-out") redirect("/login");
  if (gate !== "needs-setup") redirect(gate === "ok" ? "/" : gatePath[gate]);

  // The factor must be this user's own, unverified TOTP factor.
  const { data: factors } = await supabase.auth.mfa.listFactors();
  const own = factors?.all.some((f) => f.id === parsed.data.factorId && f.factor_type === "totp" && f.status === "unverified");
  if (!own) return { error: "setupExpired" };

  const { error } = await supabase.auth.mfa.challengeAndVerify(parsed.data);
  if (error) return { error: isRateLimited(error) ? "rateLimited" : "codeWrong" };
  // The first sign-in finishes here (password, then the new authenticator): one "signed in" row.
  await recordAuthEvent(supabase, "sign_in");
  redirect("/");
}

export async function verifyTotp(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = code.safeParse(String(formData.get("code") ?? "").replace(/\s/g, ""));
  const next = safeNext(formData.get("next"));
  if (!parsed.success) return { error: "codeInvalid" };

  const { gate, supabase } = await getGate();
  if (gate === "signed-out") redirect("/login");
  if (gate === "needs-setup") redirect("/mfa/setup");
  if (gate === "ok") redirect(next);

  const { data: factors } = await supabase.auth.mfa.listFactors();
  const factor = factors?.totp[0];
  if (!factor) redirect("/mfa/setup");

  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code: parsed.data });
  if (error) return { error: isRateLimited(error) ? "rateLimited" : "codeWrong" };
  // A sign-in is complete once the code is accepted (every account has an authenticator): one "signed in" row.
  await recordAuthEvent(supabase, "sign_in");
  redirect(next);
}
