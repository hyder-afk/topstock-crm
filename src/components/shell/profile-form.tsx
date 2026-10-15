"use client";

import { useActionState, useId } from "react";
import { useTranslations } from "next-intl";
import { updateProfile, type ProfileState } from "@/app/(app)/actions";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// The person's own name (the Home greeting uses the first name). If it could not be read, the form says so and stays
// locked: saving blank fields would overwrite a name we could not see.
export function ProfileForm({
  firstName,
  lastName,
  unavailable = false,
}: {
  firstName: string;
  lastName: string;
  unavailable?: boolean;
}) {
  const t = useTranslations("Profile");
  const [state, action, pending] = useActionState<ProfileState, FormData>(updateProfile, undefined);
  const first = useId();
  const last = useId();
  const msg = useId();
  return (
    <form noValidate action={action} className="flex flex-col gap-4">
      <fieldset disabled={unavailable} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor={first}>{t("firstName")}</Label>
          <Input
            id={first}
            name="first_name"
            defaultValue={firstName}
            maxLength={80}
            autoComplete="given-name"
            aria-describedby={msg}
            aria-invalid={state?.error === "invalid" || undefined}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={last}>{t("lastName")}</Label>
          <Input
            id={last}
            name="last_name"
            defaultValue={lastName}
            maxLength={80}
            autoComplete="family-name"
            aria-describedby={msg}
            aria-invalid={state?.error === "invalid" || undefined}
          />
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" variant="neutral" disabled={pending || unavailable}>
          {pending ? t("saving") : t("save")}
        </Button>
        <FormMessage id={msg} tone={unavailable || state?.error ? "error" : "info"}>
          {unavailable
            ? t("errors.load")
            : state?.error
              ? t(`errors.${state.error}`)
              : state?.saved
                ? t("saved")
                : null}
        </FormMessage>
      </div>
    </form>
  );
}
