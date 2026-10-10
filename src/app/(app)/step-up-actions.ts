"use server";

import { z } from "zod";
import type { AuthError } from "@supabase/supabase-js";
import { requireSession, stepUpSecondsLeft } from "@/lib/auth";

// "Confirm it's you": checks a fresh authenticator code for a signed-in (aal2) user, which renews the code time in the
// session, so the database's step-up rule (a code from the last 10 minutes) passes again. Answers with a short code;
// never redirects (the dialog stays where the person was) and never returns a raw auth error.
export type StepUpResult =
  | { ok: true; secondsLeft: number }
  | { ok: false; error: "codeInvalid" | "codeWrong" | "rateLimited" | "unavailable" };

const code = z.string().regex(/^\d{6}$/);

function isRateLimited(error: AuthError) {
  return error.status === 429 || error.code === "over_request_rate_limit";
}

export async function verifyStepUp(input: unknown): Promise<StepUpResult> {
  const parsed = code.safeParse(typeof input === "string" ? input.replace(/\s/g, "") : input);
  if (!parsed.success) return { ok: false, error: "codeInvalid" };
  const { supabase } = await requireSession();
  const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
  const factor = factors?.totp[0];
  if (listError || !factor) return { ok: false, error: "unavailable" };
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code: parsed.data });
  if (error) return { ok: false, error: isRateLimited(error) ? "rateLimited" : "codeWrong" };
  const { data } = await supabase.auth.getClaims();
  return { ok: true, secondsLeft: data?.claims ? stepUpSecondsLeft(data.claims) : 0 };
}
