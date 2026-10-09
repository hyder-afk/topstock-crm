import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Where a session stands on the way in: no session, password done but no authenticator yet,
// password done and an authenticator to check, or fully signed in (aal2).
export type Gate = "signed-out" | "needs-setup" | "needs-verify" | "ok";

export async function getGate() {
  const supabase = await createClient();
  // getClaims verifies the JWT signature; the cookie alone is never trusted.
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims ?? null;
  if (!claims) return { gate: "signed-out" as Gate, supabase, claims };
  if (claims.aal === "aal2") return { gate: "ok" as Gate, supabase, claims };
  // aal1: ask the auth server (not the cookie) whether a verified authenticator exists.
  const { data: factors, error } = await supabase.auth.mfa.listFactors();
  if (error || !factors) return { gate: "signed-out" as Gate, supabase, claims: null };
  return { gate: (factors.totp.length > 0 ? "needs-verify" : "needs-setup") as Gate, supabase, claims };
}

export const gatePath: Record<Exclude<Gate, "ok">, string> = {
  "signed-out": "/login",
  "needs-setup": "/mfa/setup",
  "needs-verify": "/mfa",
};

// Every app page and action calls this first: anything short of aal2 is sent back to the right step.
export async function requireSession() {
  const state = await getGate();
  if (state.gate !== "ok") redirect(gatePath[state.gate]);
  if (!state.claims) redirect("/login");
  return { supabase: state.supabase, claims: state.claims };
}

// Only these internal paths may be used as a "continue to" target (no open redirects).
const allowedNext = ["/set-password"] as const;
export function safeNext(value: unknown): string {
  return allowedNext.find((p) => p === value) ?? "/";
}
