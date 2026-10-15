import { z } from "zod";

// The Team screen (More > Team): admins change people's roles through public.set_user_role (core schema: admin, a
// two-factor code from the last 10 minutes, same organisation, never the last admin, an audit row). Pure rules shared by
// the server action, the screen and the unit tests.

export const roles = ["admin", "manager", "rep"] as const;
export type Role = (typeof roles)[number];

/** The action's only input: whose role, and the new role. Anything else is refused (strictObject). */
export const roleChangeInput = z.strictObject({ userId: z.uuid(), role: z.enum(roles) });

export type RoleChangeError = "step_up" | "last_admin" | "forbidden" | "not_found" | "invalid" | "unavailable";
/** `at`: the server's time when the database answered (compared with the time the page read its list). */
export type RoleChangeResult = { ok: true; at: number } | { ok: false; error: RoleChangeError };

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

/**
 * Roles set on the screen that the server's list may not show yet, per person. `savedAt` is null while the change is
 * being saved, then the server's time the database answered. `seq` tells this save from a later one on the same row.
 */
export type LocalRole = { role: Role; seq: number; savedAt: number | null };
export type LocalRoles = Record<string, LocalRole>;
/** The server's list as the page drew it: the server's time just before the people were read. */
export type ServerList = { readAt: number };

export function startSave(local: LocalRoles, id: string, role: Role, seq: number): LocalRoles {
  return { ...local, [id]: { role, seq, savedAt: null } };
}

/**
 * A save's answer. Only the row's latest save counts (an older call's answer is ignored). A refusal goes back to the
 * server's role. A saved role is kept until the page draws a list read after the database answered, unless the list
 * already on screen was read after it.
 */
export function settleSave(
  local: LocalRoles,
  id: string,
  seq: number,
  outcome: { ok: true; at: number } | { ok: false },
  list: ServerList,
): LocalRoles {
  const mine = local[id];
  if (!mine || mine.seq !== seq) return local;
  if (!outcome.ok || list.readAt > outcome.at) return without(local, id);
  return { ...local, [id]: { ...mine, savedAt: outcome.at } };
}

/**
 * A new list from the server: a saved role is dropped once the list was read after the database answered, whatever role
 * it shows (a colleague may have changed it again since). A list read earlier (the page drawn again after "Confirm it's
 * you" renewed the session) leaves it. A role still being saved always stays.
 */
export function reconcile(local: LocalRoles, list: ServerList): LocalRoles {
  const kept = Object.entries(local).filter(([, r]) => r.savedAt === null || list.readAt <= r.savedAt);
  return kept.length === Object.keys(local).length ? local : Object.fromEntries(kept);
}

function without(local: LocalRoles, id: string): LocalRoles {
  return Object.fromEntries(Object.entries(local).filter(([k]) => k !== id));
}

export function isSaving(local: LocalRoles, id: string) {
  return local[id]?.savedAt === null;
}

/** Read the list again after a save, and after a lost answer: the database may have saved the change all the same. */
export function refreshAfter(result: RoleChangeResult) {
  return result.ok || result.error === "unavailable";
}
