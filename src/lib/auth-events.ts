import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Sign-ins in the audit log (Gate 1, Haider 15 Oct 2026: who and when, no IP address). Called right after the auth
// server accepts an authenticator code, with the person's own (now aal2) session: the database function writes one row
// about the caller and nothing else (migration 20261021100000_day7a_security.sql). Best effort: a failed write never
// blocks a sign-in or a step-up, and nothing is logged here (no address, no error text).
export type AuthEvent = "sign_in" | "mfa_verify";

export async function recordAuthEvent(supabase: SupabaseClient, event: AuthEvent): Promise<void> {
  try {
    await supabase.rpc("record_auth_event", { p_event: event });
  } catch {
    // The sign-in itself succeeded; the audit row is the only thing missed.
  }
}
