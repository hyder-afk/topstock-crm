"use client";

import { useId, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Combobox } from "@/components/ui/combobox";
import { Select } from "@/components/ui/select";
import { countriesByName } from "@/lib/countries";
import { leadInput, leadStatuses, personName, type LeadDetail, type TeamMember } from "@/lib/leads";

export type LeadFormValues = {
  name: string;
  owner: string;
  status: (typeof leadStatuses)[number];
  phone: string;
  email: string;
  city: string;
  country: string;
};

type FieldError = "name" | "email" | "phone";

export function emptyLead(ownerId: string): LeadFormValues {
  return { name: "", owner: ownerId, status: "cold", phone: "", email: "", city: "", country: "" };
}

export function leadToValues(lead: LeadDetail): LeadFormValues {
  return {
    name: lead.name,
    owner: lead.owner?.id ?? "",
    status: lead.lead_status,
    phone: lead.phone ?? "",
    email: lead.email ?? "",
    city: lead.city ?? "",
    country: lead.country ?? "",
  };
}

// The same form adds and edits a lead. Checked here first (with the server's own schema), then again on the server.
export function LeadForm({
  initial,
  team,
  canAssign,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: LeadFormValues;
  team: TeamMember[];
  canAssign: boolean;
  submitLabel: string;
  onSubmit: (values: LeadFormValues) => Promise<"invalid" | "forbidden" | "unavailable" | null>;
  onCancel: () => void;
}) {
  const t = useTranslations("Leads.form");
  const tStatus = useTranslations("Leads.status");
  const tErr = useTranslations("Leads.errors");
  const tLeads = useTranslations("Leads");
  const locale = useLocale();
  const countries = useMemo(() => countriesByName(locale), [locale]);
  const [values, setValues] = useState(initial);
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [formError, setFormError] = useState<"invalid" | "forbidden" | "unavailable" | null>(null);
  const [pending, setPending] = useState(false);
  const id = useId();
  const msg = `${id}-msg`;

  const set = <K extends keyof LeadFormValues>(key: K, value: LeadFormValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = leadInput.safeParse(values);
    if (!parsed.success) {
      const paths = new Set(parsed.error.issues.map((i) => String(i.path[0])));
      const errs = (["name", "email", "phone"] as const).filter((f) => paths.has(f));
      setFieldErrors(errs);
      setFormError("invalid");
      if (errs[0]) document.getElementById(`${id}-${errs[0]}`)?.focus();
      return;
    }
    setFieldErrors([]);
    setPending(true);
    const error = await onSubmit(values);
    setPending(false);
    setFormError(error);
  }

  const invalid = (f: FieldError) => fieldErrors.includes(f) || undefined;
  const owners = team.filter((m) => canAssign || m.id === initial.owner);

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-name`}>{t("name")}</Label>
        <Input
          id={`${id}-name`}
          name="name"
          value={values.name}
          onChange={(e) => set("name", e.target.value)}
          maxLength={200}
          autoComplete="organization"
          aria-invalid={invalid("name")}
          aria-describedby={invalid("name") ? `${id}-name-err` : undefined}
          required
        />
        {invalid("name") ? (
          <p id={`${id}-name-err`} className="text-sm text-status-red">
            {tErr("name")}
          </p>
        ) : null}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-status`}>{t("status")}</Label>
          <Select id={`${id}-status`} name="status" value={values.status} onChange={(e) => set("status", e.target.value as LeadFormValues["status"])}>
            {leadStatuses.map((s) => (
              <option key={s} value={s}>
                {tStatus(s)}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-owner`}>{t("owner")}</Label>
          <Select
            id={`${id}-owner`}
            name="owner"
            value={values.owner}
            onChange={(e) => set("owner", e.target.value)}
            disabled={!canAssign}
            aria-describedby={!canAssign ? `${id}-owner-hint` : undefined}
          >
            {canAssign ? <option value="">{t("noOwner")}</option> : null}
            {owners.map((m) => (
              <option key={m.id} value={m.id}>
                {personName(m) || tLeads("noName")}
              </option>
            ))}
          </Select>
          {!canAssign ? (
            <p id={`${id}-owner-hint`} className="text-sm text-muted-foreground">
              {t("repOwner")}
            </p>
          ) : null}
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
            autoComplete="tel"
            aria-invalid={invalid("phone")}
            aria-describedby={invalid("phone") ? `${id}-phone-err` : undefined}
          />
          {invalid("phone") ? (
            <p id={`${id}-phone-err`} className="text-sm text-status-red">
              {tErr("phone")}
            </p>
          ) : null}
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
            autoComplete="email"
            spellCheck={false}
            aria-invalid={invalid("email")}
            aria-describedby={invalid("email") ? `${id}-email-err` : undefined}
          />
          {invalid("email") ? (
            <p id={`${id}-email-err`} className="text-sm text-status-red">
              {tErr("email")}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-city`}>{t("city")}</Label>
          <Input
            id={`${id}-city`}
            name="city"
            value={values.city}
            onChange={(e) => set("city", e.target.value)}
            maxLength={120}
            autoComplete="address-level2"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-country`}>{t("country")}</Label>
          {/* About 250 countries: a searchable list (accents and case ignored). */}
          <Combobox id={`${id}-country`} name="country" value={values.country} onChange={(e) => set("country", e.target.value)}>
            <option value="">{t("chooseCountry")}</option>
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </Combobox>
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
          {pending ? t("saving") : submitLabel}
        </Button>
      </div>
    </form>
  );
}
