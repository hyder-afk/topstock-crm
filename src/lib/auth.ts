import "server-only";
import { notFound, redirect } from "next/navigation";
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

// Route handlers (JSON APIs) answer 401 instead of redirecting; the same aal2 rule applies.
export async function apiSession() {
  const state = await getGate();
  if (state.gate !== "ok" || !state.claims) return null;
  return { supabase: state.supabase, claims: state.claims };
}

// Step-up MFA (Master Plan F3): imports, exports, deletes and role changes need an authenticator code entered in the last
// 10 minutes; the database checks the same window (private.has_recent_aal2(600)).
export const STEP_UP_SECONDS = 600;

// Seconds left before the code in this session stops counting as fresh, with a 30 s margin so an action started now
// still finishes inside the window. Read from the verified JWT (amr), on the server, so the browser clock never matters.
export function stepUpSecondsLeft(claims: Record<string, unknown>, nowMs = Date.now()): number {
  const amr = Array.isArray(claims.amr) ? claims.amr : [];
  const times = amr
    .filter((m): m is { method: string; timestamp: number } => typeof m === "object" && m !== null && "method" in m)
    .filter((m) => m.method === "totp" && Number.isInteger(m.timestamp))
    .map((m) => m.timestamp);
  if (claims.aal !== "aal2" || times.length === 0) return 0;
  return Math.max(0, Math.floor(Math.max(...times) + STEP_UP_SECONDS - nowMs / 1000 - 30));
}

// Admin-only pages: everyone else gets the standard 404 (the database refuses them too; this only hides the page).
export async function requireAdmin() {
  const session = await requireSession();
  const { data, error } = await session.supabase.from("profiles").select("role").eq("id", session.claims.sub).maybeSingle();
  if (error || data?.role !== "admin") notFound();
  return session;
}
