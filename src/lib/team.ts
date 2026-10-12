import { z } from "zod";

// The Team screen (More > Team): admins change people's roles through public.set_user_role (core schema: admin, a
// two-factor code from the last 10 minutes, same organisation, never the last admin, an audit row). Pure rules shared by
// the server action, the screen and the unit tests.

export const roles = ["admin", "manager", "rep"] as const;
export type Role = (typeof roles)[number];

/** The action's only input: whose role, and the new role. Anything else is refused (strictObject). */
export const roleChangeInput = z.strictObject({ userId: z.uuid(), role: z.enum(roles) });

export type RoleChangeError = "step_up" | "last_admin" | "forbidden" | "not_found" | "invalid" | "unavailable";
export type RoleChangeResult = { ok: true } | { ok: false; error: RoleChangeError };

/**
 * The screen's answer for a refusal of set_user_role. Only the SQLSTATE and the hint are read, never the database's
 * message. The function answers 42501 for three causes without a hint (not an admin; no code in the last 10 minutes;
 * the last admin), checked in that order, so the server action says what it knows: whether the caller is an admin (read
 * again after the refusal) and whether the session's code was still fresh when the call was made (read from the
 * verified token, with a 30 s margin, so the database saw it as fresh too). Hints `step_up` and `last_admin` are read
 * first, should the function ever send them.
 */
export function roleChangeError(
  error: { code?: string | null; hint?: string | null } | null | undefined,
  caller: { isAdmin: boolean | null; codeFresh: boolean },
): RoleChangeError {
  const code = error?.code ?? "";
  const hint = error?.hint ?? "";
  if (code === "42501") {
    if (hint === "step_up") return "step_up";
    if (hint === "last_admin") return "last_admin";
    if (caller.isAdmin === null) return "unavailable";
    if (!caller.isAdmin) return "forbidden";
    if (!caller.codeFresh) return "step_up";
    return "last_admin";
  }
  if (code === "P0002") return "not_found";
  if (code === "22P02" || code === "22023") return "invalid";
  return "unavailable";
}

/** The message for a refusal the screen shows (step_up never reaches it: the screen asks for a code instead). */
export function errorMessageKey(error: RoleChangeError, isSelf: boolean) {
  switch (error) {
    case "last_admin":
      return isSelf ? "last_admin_self" : "last_admin";
    case "forbidden":
    case "not_found":
      return error;
    default:
      return "unavailable";
  }
}

/** One person as the Team screen shows them (columns of public.profiles every member of the organisation may read). */
export type Person = { id: string; firstName: string; lastName: string; role: Role; createdAt: string };

export function displayName(p: Pick<Person, "firstName" | "lastName">) {
  return `${p.firstName} ${p.lastName}`.trim();
}

/**
 * What tells apart someone who has not added a name yet: the first 8 characters of their user id, the start of the UID
 * the Supabase dashboard lists under Authentication > Users (profiles holds no email; reading auth.users would need the
 * service key or a new definer function).
 */
export function shortId(id: string) {
  return id.slice(0, 8);
}

/** The signed-in person first, then names A to Z (the locale's order), then people without a name, oldest first. */
export function sortPeople(people: Person[], me: string, locale: string): Person[] {
  const collator = new Intl.Collator(locale, { sensitivity: "base" });
  return [...people].sort((a, b) => {
    if (a.id === me || b.id === me) return a.id === me ? (b.id === me ? 0 : -1) : 1;
    const an = displayName(a);
    const bn = displayName(b);
    if (!an !== !bn) return an ? -1 : 1;
    return (an && bn ? collator.compare(an, bn) : 0) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  });
}

/** A profiles row as PostgREST returns it, checked before it reaches the screen. */
const profileRow = z.object({
  id: z.string(),
  first_name: z.string(),
  last_name: z.string(),
  role: z.enum(roles),
  created_at: z.string(),
});

export function toPeople(rows: unknown): Person[] | null {
  const parsed = z.array(profileRow).safeParse(rows);
  if (!parsed.success) return null;
  return parsed.data.map((r) => ({ id: r.id, firstName: r.first_name, lastName: r.last_name, role: r.role, createdAt: r.created_at }));
}
