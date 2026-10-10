"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { contactInput, type Contact } from "@/lib/leads";

export type ContactValues = { first_name: string; last_name: string; title: string; email: string; phone: string };

export function contactToValues(c?: Contact): ContactValues {
  return {
    first_name: c?.first_name ?? "",
    last_name: c?.last_name ?? "",
    title: c?.title ?? "",
    email: c?.email ?? "",
    phone: c?.phone ?? "",
  };
}

type FieldError = "first_name" | "email" | "phone";

// Adds or edits one person at the lead. Validated here with the server's schema, then on the server.
export function ContactForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: ContactValues;
  onSubmit: (values: ContactValues) => Promise<"invalid" | "forbidden" | "unavailable" | null>;
  onCancel: () => void;
}) {
  const t = useTranslations("Leads.contactForm");
  const tErr = useTranslations("Leads.errors");
  const [values, setValues] = useState(initial);
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [formError, setFormError] = useState<"invalid" | "forbidden" | "unavailable" | null>(null);
  const [pending, setPending] = useState(false);
  const id = useId();
  const msg = `${id}-msg`;
  const set = (key: keyof ContactValues, value: string) => setValues((v) => ({ ...v, [key]: value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = contactInput.safeParse(values);
    if (!parsed.success) {
      const paths = new Set(parsed.error.issues.map((i) => String(i.path[0])));
      const errs = (["first_name", "email", "phone"] as const).filter((f) => paths.has(f));
      setFieldErrors(errs);
      setFormError("invalid");
      const inputId = { first_name: "first", email: "email", phone: "phone" } as const;
      if (errs[0]) document.getElementById(`${id}-${inputId[errs[0]]}`)?.focus();
      return;
    }
    setFieldErrors([]);
    setPending(true);
    const error = await onSubmit(values);
    setPending(false);
    setFormError(error);
  }

  const invalid = (f: FieldError) => fieldErrors.includes(f) || undefined;
  const errText: Record<FieldError, string> = {
    first_name: tErr("contactName"),
    email: tErr("email"),
    phone: tErr("phone"),
  };
  const err = (f: FieldError) =>
    invalid(f) ? (
      <p id={`${id}-${f}-err`} className="text-sm text-status-red">
        {errText[f]}
      </p>
    ) : null;

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4 rounded-md border border-border p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-first`}>{t("firstName")}</Label>
          <Input
            id={`${id}-first`}
            name="first_name"
            value={values.first_name}
            onChange={(e) => set("first_name", e.target.value)}
            maxLength={120}
            autoComplete="off"
            aria-invalid={invalid("first_name")}
            aria-describedby={invalid("first_name") ? `${id}-first_name-err` : undefined}
          />
          {err("first_name")}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-last`}>{t("lastName")}</Label>
          <Input id={`${id}-last`}
            name="last_name" value={values.last_name} onChange={(e) => set("last_name", e.target.value)} maxLength={120} autoComplete="off" />
        </div>
        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label htmlFor={`${id}-title`}>{t("title")}</Label>
          <Input
            id={`${id}-title`}
            name="title"
            value={values.title}
            onChange={(e) => set("title", e.target.value)}
            maxLength={120}
            placeholder={t("titlePlaceholder")}
            autoComplete="off"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-phone`}>{t("phone")}</Label>
          <Input
            id={`${id}-phone`}
            name="phone"
            type="tel"
            inputMode="tel"
            value={values.phone}
            onChange={(e) => set("phone", e.target.value)}
            maxLength={40}
            autoComplete="off"
            aria-invalid={invalid("phone")}
            aria-describedby={invalid("phone") ? `${id}-phone-err` : undefined}
          />
          {err("phone")}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-email`}>{t("email")}</Label>
          <Input
            id={`${id}-email`}
            name="email"
            type="email"
            value={values.email}
            onChange={(e) => set("email", e.target.value)}
            maxLength={254}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={invalid("email")}
            aria-describedby={invalid("email") ? `${id}-email-err` : undefined}
          />
          {err("email")}
        </div>
      </div>
      <FormMessage id={msg} tone="error">
        {formError ? tErr(formError) : null}
      </FormMessage>
      <div className="flex flex-wrap justify-end gap-3">
        <Button type="button" variant="quiet" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button type="submit" variant="neutral" disabled={pending} aria-describedby={msg}>
          {pending ? t("saving") : t("save")}
        </Button>
      </div>
    </form>
  );
}
