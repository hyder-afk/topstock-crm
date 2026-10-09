"use server";

import { cookies } from "next/headers";
import { isLocale, localeCookie } from "@/i18n/config";

// Whitelisted values only; anything else is ignored.
export async function setLocale(value: string) {
  if (!isLocale(value)) return;
  const store = await cookies();
  store.set(localeCookie, value, { path: "/", sameSite: "lax", secure: true, httpOnly: true, maxAge: 60 * 60 * 24 * 365 });
}
