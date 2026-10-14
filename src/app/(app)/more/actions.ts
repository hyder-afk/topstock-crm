"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { invalid, toActionFailure, type ActionResult } from "@/lib/db-errors";

// The person's own time zone (Day 4 design 7.5: "Today" on the Tasks page and the queue's follow-ups follow it).
// Zod: an IANA name this server knows (Intl), or UTC; the database checks it against PostgreSQL's own list
// (set_my_timezone, hint "timezone").
const zone = z
  .string()
  .max(64)
  .refine((v) => v === "UTC" || (typeof Intl.supportedValuesOf === "function" && Intl.supportedValuesOf("timeZone").includes(v)));
const timezoneInput = z.strictObject({ timezone: zone });

export async function saveTimezone(input: unknown): Promise<ActionResult<{ timezone: string }>> {
  const parsed = timezoneInput.safeParse(input);
  if (!parsed.success) return invalid("timezone");
  const { supabase } = await requireSession();
  const { data, error } = await supabase.rpc("set_my_timezone", { p_timezone: parsed.data.timezone });
  if (error) return toActionFailure(error);
  revalidatePath("/tasks");
  return { ok: true, data: data as { timezone: string } };
}
