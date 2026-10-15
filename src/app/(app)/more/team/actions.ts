"use server";

import { requireSession, stepUpSecondsLeft } from "@/lib/auth";
import { roleChangeError, roleChangeInput, type RoleChangeResult } from "@/lib/team";

// Change one person's role (More > Team). Zod on the input, the aal2 session, then the database function, which decides
// everything (admin, a code from the last 10 minutes, same organisation, never the last admin, the audit row). The
// answer is a short code; the screen words it in the person's language.
export async function changeRole(input: unknown): Promise<RoleChangeResult> {
  const parsed = roleChangeInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const { supabase, claims } = await requireSession();
  // A code about to go stale is asked for again before the call (the same 30 s margin the screen's timer uses).
  const codeFresh = stepUpSecondsLeft(claims) > 0;
  if (!codeFresh) return { ok: false, error: "step_up" };
  const { error } = await supabase.rpc("set_user_role", { target_user: parsed.data.userId, new_role: parsed.data.role });
  // The server's time once the database answered: the screen keeps the new role until it draws a list read after it.
  if (!error) return { ok: true, at: Date.now() };
  let isAdmin: boolean | null = null;
  if (error.code === "42501" && !error.hint) {
    // Which of the function's three 42501 refusals it was: the caller's role now (their own row, readable by them).
    const me = await supabase.from("profiles").select("role").eq("id", claims.sub).maybeSingle();
    isAdmin = me.error ? null : me.data?.role === "admin";
  }
  return { ok: false, error: roleChangeError(error, { isAdmin, codeFresh }) };
}
