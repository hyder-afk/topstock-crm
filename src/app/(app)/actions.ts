"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/auth";

export type ProfileState = { error?: "invalid" | "unavailable"; saved?: boolean } | undefined;

// Only these two fields, from the signed-in person's own row (RLS and column grants allow nothing else).
const profileInput = z.object({
  first_name: z.string().trim().max(80),
  last_name: z.string().trim().max(80),
});

export async function updateProfile(_prev: ProfileState, formData: FormData): Promise<ProfileState> {
  const parsed = profileInput.safeParse({ first_name: formData.get("first_name"), last_name: formData.get("last_name") });
  if (!parsed.success) return { error: "invalid" };
  const { supabase, claims } = await requireSession();
  const { error } = await supabase.from("profiles").update(parsed.data).eq("id", claims.sub);
  if (error) return { error: "unavailable" };
  revalidatePath("/", "layout");
  return { saved: true };
}
