"use server";

import { cookies } from "next/headers";
import { z } from "zod";
import { localeCookie, locales } from "@/i18n/config";

const localeInput = z.enum(locales);

// Zod-validated; anything that is not "en" or "fr" is ignored.
export async function setLocale(input: unknown) {
  const parsed = localeInput.safeParse(input);
  if (!parsed.success) return;
  const store = await cookies();
  store.set(localeCookie, parsed.data, { path: "/", sameSite: "lax", secure: true, httpOnly: true, maxAge: 60 * 60 * 24 * 365 });
}
