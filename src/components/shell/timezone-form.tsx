"use client";

import { useId, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { saveTimezone } from "@/app/(app)/more/actions";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { FormMessage } from "@/components/ui/form-message";
import { Label } from "@/components/ui/label";
import { browserZone } from "@/lib/timezones";

const noop = () => () => {};

// "Your time zone" (Day 4 design 7.5): "Today" on the Tasks page and the queue's follow-ups follow it. A closed list
// (the zones this server knows, sent by the page so the server and the browser draw the same options), plus "Use this
// device's zone (Asia/Karachi)" when the device's zone differs and is on the list. The database checks the zone again.
export function TimezoneForm({ current, zones, unavailable = false }: { current: string; zones: string[]; unavailable?: boolean }) {
  const t = useTranslations("Profile");
  const router = useRouter();
  const queryClient = useQueryClient();
  const id = useId();
  const msg = useId();
  const [value, setValue] = useState(current);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const device = useSyncExternalStore(noop, () => browserZone(), () => null);
  const options = zones.includes(current) ? zones : [current, ...zones];

  const save = async (zone: string) => {
    setState("saving");
    const res = await saveTimezone({ timezone: zone }).catch(() => ({ ok: false as const, error: "unavailable" as const }));
    if (!res.ok) {
      setState("error");
      return;
    }
    setState("saved");
    // The Tasks lists already read put tasks in buckets by the old zone: they are read again.
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    router.refresh();
  };

  return (
    <form noValidate
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save(value);
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor={id}>{t("timezone")}</Label>
        <Combobox
          id={id}
          name="timezone"
          value={value}
          disabled={unavailable}
          onChange={(e) => {
            setValue(e.target.value);
            setState("idle");
          }}
          aria-describedby={`${id}-help ${msg}`}
          className="max-w-md"
          options={options.map((z) => ({ value: z, label: z.replace(/_/g, " ") }))}
        />
        <p id={`${id}-help`} className="text-sm text-muted-foreground">
          {t("timezoneHelp")}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="neutral" disabled={unavailable || state === "saving"}>
          {state === "saving" ? t("saving") : t("timezoneSave")}
        </Button>
        {device && device !== value && options.includes(device) && !unavailable ? (
          <Button
            variant="quiet"
            onClick={() => {
              setValue(device);
              void save(device);
            }}
          >
            {t("timezoneDevice", { zone: device })}
          </Button>
        ) : null}
        {/* When the profile cannot be read, the name form above already says so (one alert per page); this one stays locked. */}
        {/* A polite live line (not a second status region on More, which the name form already has); errors as an alert. */}
        {state === "error" ? (
          <FormMessage id={msg} tone="error">
            {t("timezoneError")}
          </FormMessage>
        ) : (
          <p id={msg} aria-live="polite" className="min-h-6 text-sm text-muted-foreground">
            {state === "saved" ? t("timezoneSaved") : null}
          </p>
        )}
      </div>
    </form>
  );
}
