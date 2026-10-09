"use client";

import { useActionState, useId, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  confirmEmailLink,
  requestPasswordReset,
  setPassword,
  signIn,
  signOut,
  startTotpEnrollment,
  verifyTotp,
  verifyTotpEnrollment,
  type EnrollState,
  type FormState,
} from "@/app/(auth)/actions";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function useErrorText() {
  const t = useTranslations("Auth.errors");
  return (code?: string) => (code && t.has(code) ? t(code) : code ? t("unavailable") : undefined);
}

function Field({
  label,
  invalid,
  describedBy,
  ...input
}: { label: string; invalid?: boolean; describedBy?: string } & React.ComponentProps<"input">) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} aria-invalid={invalid || undefined} aria-describedby={describedBy} {...input} />
    </div>
  );
}

function CodeField({ invalid, describedBy, label }: { invalid?: boolean; describedBy?: string; label: string }) {
  return (
    <Field
      label={label}
      name="code"
      required
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9 ]{6,7}"
      maxLength={7}
      autoFocus
      spellCheck={false}
      invalid={invalid}
      describedBy={describedBy}
      className="font-mono text-2xl tracking-[0.3em]"
    />
  );
}

export function LoginForm() {
  const t = useTranslations("Auth");
  const errorText = useErrorText();
  const [state, action, pending] = useActionState<FormState, FormData>(signIn, undefined);
  const msg = useId();
  return (
    <form action={action} className="flex flex-col gap-4">
      <Field
        label={t("email")}
        name="email"
        type="email"
        required
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        defaultValue={state?.email}
        invalid={!!state?.error}
        describedBy={msg}
        autoFocus
      />
      <Field
        label={t("password")}
        name="password"
        type="password"
        required
        autoComplete="current-password"
        invalid={!!state?.error}
        describedBy={msg}
      />
      <FormMessage id={msg} tone="error">
        {errorText(state?.error)}
      </FormMessage>
      <Button type="submit" width="full" disabled={pending}>
        {pending ? t("signingIn") : t("signIn")}
      </Button>
      <Link href="/forgot-password" className="self-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline min-h-11 inline-flex items-center">
        {t("forgotLink")}
      </Link>
    </form>
  );
}

export function ForgotPasswordForm() {
  const t = useTranslations("Auth");
  const errorText = useErrorText();
  const [state, action, pending] = useActionState<FormState, FormData>(requestPasswordReset, undefined);
  const msg = useId();
  if (state?.done) {
    return (
      <div className="flex flex-col gap-4">
        <FormMessage tone="info">{t("forgotDone")}</FormMessage>
        <BackToSignIn />
      </div>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-4">
      <Field
        label={t("email")}
        name="email"
        type="email"
        required
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        invalid={!!state?.error}
        describedBy={msg}
        autoFocus
      />
      <FormMessage id={msg} tone="error">
        {errorText(state?.error)}
      </FormMessage>
      <Button type="submit" width="full" disabled={pending}>
        {pending ? t("sending") : t("sendLink")}
      </Button>
      <BackToSignIn />
    </form>
  );
}

function BackToSignIn() {
  const t = useTranslations("Auth");
  return (
    <Link href="/login" className="self-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline min-h-11 inline-flex items-center">
      {t("backToSignIn")}
    </Link>
  );
}

export function ConfirmLinkForm({ tokenHash, type }: { tokenHash: string; type: string }) {
  const t = useTranslations("Auth");
  const errorText = useErrorText();
  const [state, action, pending] = useActionState<FormState, FormData>(confirmEmailLink, undefined);
  const msg = useId();
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="token_hash" value={tokenHash} />
      <input type="hidden" name="type" value={type} />
      <FormMessage id={msg} tone="error">
        {errorText(state?.error)}
      </FormMessage>
      {state?.error === "linkInvalid" ? (
        <BackToSignIn />
      ) : (
        <Button type="submit" width="full" disabled={pending} aria-describedby={msg}>
          {pending ? t("continuing") : t("continue")}
        </Button>
      )}
    </form>
  );
}

export function SetPasswordForm() {
  const t = useTranslations("Auth");
  const errorText = useErrorText();
  const [state, action, pending] = useActionState<FormState, FormData>(setPassword, undefined);
  const msg = useId();
  return (
    <form action={action} className="flex flex-col gap-4">
      {/* Lets password managers save the new password against the right account. */}
      <Field
        label={t("newPassword")}
        name="password"
        type="password"
        required
        minLength={12}
        maxLength={72}
        autoComplete="new-password"
        invalid={!!state?.error}
        describedBy={msg}
        autoFocus
      />
      <Field
        label={t("confirmPassword")}
        name="confirm"
        type="password"
        required
        minLength={12}
        maxLength={72}
        autoComplete="new-password"
        invalid={!!state?.error}
        describedBy={msg}
      />
      <FormMessage id={msg} tone="error">
        {errorText(state?.error)}
      </FormMessage>
      <Button type="submit" width="full" disabled={pending}>
        {pending ? t("saving") : t("savePassword")}
      </Button>
    </form>
  );
}

export function VerifyTotpForm({ next }: { next: string }) {
  const t = useTranslations("Auth");
  const errorText = useErrorText();
  const [state, action, pending] = useActionState<FormState, FormData>(verifyTotp, undefined);
  const msg = useId();
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <CodeField label={t("code")} invalid={!!state?.error} describedBy={msg} />
      <FormMessage id={msg} tone="error">
        {errorText(state?.error)}
      </FormMessage>
      <Button type="submit" width="full" disabled={pending}>
        {pending ? t("verifying") : t("verify")}
      </Button>
    </form>
  );
}

export function SignOutButton() {
  const t = useTranslations("Auth");
  return (
    <form action={signOut} className="self-center">
      <Button type="submit" variant="link" className="text-sm">
        {t("notYou")}
      </Button>
    </form>
  );
}

export function TotpSetup() {
  const t = useTranslations("Auth");
  const errorText = useErrorText();
  const [enroll, startAction, starting] = useActionState<EnrollState, FormData>(() => startTotpEnrollment(), undefined);
  const [state, verifyAction, verifying] = useActionState<FormState, FormData>(verifyTotpEnrollment, undefined);
  const [copied, setCopied] = useState(false);
  const msg = useId();

  if (!enroll?.factorId) {
    return (
      <form action={startAction} className="flex flex-col gap-4">
        <FormMessage id={msg} tone="error">
          {errorText(enroll?.error)}
        </FormMessage>
        <Button type="submit" width="full" disabled={starting} aria-describedby={msg}>
          {starting ? t("preparing") : t("showQr")}
        </Button>
      </form>
    );
  }

  const groupedSecret = enroll.secret.replace(/(.{4})/g, "$1 ").trim();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <p>{t("scanStep")}</p>
        {/* Supabase returns the QR code as an SVG data URL; it is shown as an image, never injected as markup. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={enroll.qr} alt={t("qrAlt")} width={192} height={192} className="mx-auto size-48 rounded-md bg-white p-2" />
        <p className="text-sm text-muted-foreground">{t("manualKey")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <code translate="no" className="break-all rounded-sm bg-muted px-2 py-1 font-mono text-sm">
            {groupedSecret}
          </code>
          <Button
            variant="quiet"
            className="min-h-11 px-3 text-sm sm:min-h-9"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(enroll.secret);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? t("copied") : t("copy")}
          </Button>
          <span className="sr-only" aria-live="polite">
            {copied ? t("copied") : ""}
          </span>
        </div>
      </div>
      <form action={verifyAction} className="flex flex-col gap-4">
        <input type="hidden" name="factorId" value={enroll.factorId} />
        <CodeField label={t("enterStep")} invalid={!!state?.error} describedBy={msg} />
        <FormMessage id={msg} tone="error">
          {errorText(state?.error)}
        </FormMessage>
        <Button type="submit" width="full" disabled={verifying}>
          {verifying ? t("verifying") : t("finishSetup")}
        </Button>
      </form>
    </div>
  );
}
