import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createTranslator } from "use-intl/core";
import {
  errorMessageKey,
  isSaving,
  reconcile,
  refreshAfter,
  roleChangeError,
  roleChangeInput,
  settleSave,
  shortId,
  sortPeople,
  startSave,
  toPeople,
  type Person,
} from "@/lib/team";

// The Team screen's rules: the action's input, how a refusal of set_user_role becomes a message, the order of the list,
// and its words in both languages.
const id = "3f2a9c1b-7d4e-4a2b-9c8d-1e2f3a4b5c6d";

test.describe("role change input (Zod strictObject)", () => {
  test("accepts a user id and one of the three roles", () => {
    for (const role of ["admin", "manager", "rep"]) {
      expect(roleChangeInput.safeParse({ userId: id, role }).success).toBe(true);
    }
  });

  test("refuses other roles, a malformed id, missing fields and any extra field", () => {
    expect(roleChangeInput.safeParse({ userId: id, role: "owner" }).success).toBe(false);
    expect(roleChangeInput.safeParse({ userId: id, role: "Admin" }).success).toBe(false);
    expect(roleChangeInput.safeParse({ userId: "not-a-uuid", role: "rep" }).success).toBe(false);
    expect(roleChangeInput.safeParse({ userId: `${id}' or 1=1`, role: "rep" }).success).toBe(false);
    expect(roleChangeInput.safeParse({ role: "rep" }).success).toBe(false);
    expect(roleChangeInput.safeParse({ userId: id }).success).toBe(false);
    expect(roleChangeInput.safeParse({ userId: id, role: "rep", org_id: id }).success).toBe(false);
    expect(roleChangeInput.safeParse({ userId: id, role: "rep", target_user: id }).success).toBe(false);
    expect(roleChangeInput.safeParse(null).success).toBe(false);
    expect(roleChangeInput.safeParse([id, "rep"]).success).toBe(false);
  });
});

test.describe("refusals of set_user_role (SQLSTATE and hint only)", () => {
  const fresh = { isAdmin: true, codeFresh: true };
  test("42501: not an admin, stale code, last admin, in the function's order", () => {
    expect(roleChangeError({ code: "42501" }, { isAdmin: false, codeFresh: true })).toBe("forbidden");
    expect(roleChangeError({ code: "42501" }, { isAdmin: false, codeFresh: false })).toBe("forbidden");
    expect(roleChangeError({ code: "42501" }, { isAdmin: true, codeFresh: false })).toBe("step_up");
    expect(roleChangeError({ code: "42501", hint: "" }, fresh)).toBe("last_admin");
    expect(roleChangeError({ code: "42501" }, { isAdmin: null, codeFresh: true })).toBe("unavailable");
  });

  test("hints win when the database sends them", () => {
    expect(roleChangeError({ code: "42501", hint: "step_up" }, fresh)).toBe("step_up");
    expect(roleChangeError({ code: "42501", hint: "last_admin" }, { isAdmin: false, codeFresh: false })).toBe("last_admin");
  });

  test("not found, invalid, and everything else is unavailable (no raw text)", () => {
    expect(roleChangeError({ code: "P0002" }, fresh)).toBe("not_found");
    expect(roleChangeError({ code: "22P02" }, fresh)).toBe("invalid");
    expect(roleChangeError({ code: "XX000", hint: "Failing row contains (secret)" }, fresh)).toBe("unavailable");
    expect(roleChangeError({ code: "PGRST301" }, fresh)).toBe("unavailable");
    expect(roleChangeError(null, fresh)).toBe("unavailable");
  });

  test("each refusal has its message; the last admin reads differently when it is you", () => {
    expect(errorMessageKey("last_admin", false)).toBe("last_admin");
    expect(errorMessageKey("last_admin", true)).toBe("last_admin_self");
    expect(errorMessageKey("forbidden", false)).toBe("forbidden");
    expect(errorMessageKey("not_found", false)).toBe("not_found");
    expect(errorMessageKey("invalid", false)).toBe("unavailable");
    expect(errorMessageKey("unavailable", true)).toBe("unavailable");
  });
});

test.describe("the list", () => {
  const p = (id: string, firstName: string, lastName: string, createdAt: string): Person => ({ id, firstName, lastName, role: "rep", createdAt });
  test("you first, then names A to Z in the locale's order, then people without a name, oldest first", () => {
    const people = [
      p("e", "", "", "2026-10-12T10:00:00Z"),
      p("b", "Zoé", "Martin", "2026-10-01T10:00:00Z"),
      p("d", "", "", "2026-10-11T10:00:00Z"),
      p("me", "Haider", "", "2026-10-09T10:00:00Z"),
      p("c", "Élodie", "Bernard", "2026-10-05T10:00:00Z"),
      p("a", "Henri", "Durand", "2026-10-02T10:00:00Z"),
    ];
    expect(sortPeople(people, "me", "fr").map((x) => x.id)).toEqual(["me", "c", "a", "b", "d", "e"]);
    // Without a name yourself, you still come first.
    expect(sortPeople(people, "e", "en")[0].id).toBe("e");
  });

  test("short id is the start of the dashboard's UID", () => {
    expect(shortId(id)).toBe("3f2a9c1b");
  });

  test("rows are checked before they reach the screen", () => {
    expect(toPeople([{ id, first_name: "A", last_name: "B", role: "manager", created_at: "2026-10-12T10:00:00Z" }])).toEqual([
      { id, firstName: "A", lastName: "B", role: "manager", createdAt: "2026-10-12T10:00:00Z" },
    ]);
    expect(toPeople([{ id, first_name: "A", last_name: "B", role: "owner", created_at: "x" }])).toBeNull();
    expect(toPeople(null)).toBeNull();
  });
});

test.describe("Team words", () => {
  type Messages = Record<string, unknown>;
  const load = (locale: string) => JSON.parse(readFileSync(path.join(__dirname, "..", "..", "messages", `${locale}.json`), "utf8")) as Messages;
  const en = load("en");
  const fr = load("fr");
  const entries = (node: unknown, prefix = ""): [string, string][] =>
    typeof node === "string"
      ? [[prefix, node]]
      : node && typeof node === "object"
        ? Object.entries(node).flatMap(([k, v]) => entries(v, prefix ? `${prefix}.${k}` : k))
        : [];

  test("English and French have the same keys (Team and the step-up body for roles)", () => {
    expect(entries(fr.Team).map(([k]) => k).sort()).toEqual(entries(en.Team).map(([k]) => k).sort());
    expect(typeof (fr.StepUp as Messages).bodyRole).toBe("string");
    expect(typeof (en.StepUp as Messages).bodyRole).toBe("string");
  });

  test("French typography: narrow no-break spaces and typographic apostrophes", () => {
    const bad = [...entries(fr.Team, "Team"), ["StepUp.bodyRole", (fr.StepUp as Messages).bodyRole as string] as [string, string]].filter(
      ([, text]) => /[  ][:;?!»]/.test(text) || /«[  ]/.test(text) || text.includes("'") || /[^ ][:;?!](\s|$)/.test(text.replace(/https?:\S+/g, "")),
    );
    expect(bad).toEqual([]);
  });

  test("role sentences and counts read right in both languages", () => {
    const say = (messages: Messages, locale: string) => createTranslator({ locale, messages, namespace: "Team" }) as unknown as (k: string, v?: Record<string, string | number>) => string;
    const e = say(en, "en");
    const f = say(fr, "fr");
    expect(e("confirm.body", { who: "Henri Durand", role: "admin" })).toBe("Henri Durand becomes an admin.");
    expect(e("announce.saved", { who: "Kais", role: "rep" })).toBe("Kais is now a rep.");
    expect(f("announce.saved", { who: "Kais", role: "manager" })).toBe("Kais est maintenant manager.");
    expect(f("roleMenu", { who: "Henri", role: "Admin" })).toBe("Rôle de Henri : Admin");
    expect(e("count", { count: 1 })).toBe("1 person");
    expect(e("count", { count: 3 })).toBe("3 people");
    expect(f("count", { count: 1 })).toBe("1 personne");
    expect(f("count", { count: 3 })).toBe("3 personnes");
  });
});

// The screen's local roles (verifier findings 3, 4 and 5). Times are the server's clock in milliseconds: `readAt` is when
// the page read the list, `at` when the database answered the save.
test.describe("local roles while saving and after", () => {
  const bob = "11111111-1111-4111-8111-111111111111";
  const cleo = "22222222-2222-4222-8222-222222222222";
  const list = (readAt: number, bobRole: "admin" | "manager" | "rep", cleoRole: "admin" | "manager" | "rep" = "rep") => ({
    readAt,
    people: [
      { id: bob, role: bobRole },
      { id: cleo, role: cleoRole },
    ],
  });

  test("a saved role stays through a list read before the save answered (the redraw after Confirm it's you)", () => {
    let local = startSave({}, bob, "manager", 1);
    local = settleSave(local, bob, 1, { ok: true, at: 1_000 }, list(900, "rep"));
    local = reconcile(local, list(950, "rep"));
    expect(local[bob]?.role).toBe("manager");
  });

  test("the first list read after the save replaces the local role, whatever it shows (a colleague changed it back)", () => {
    let local = startSave({}, bob, "manager", 1);
    local = settleSave(local, bob, 1, { ok: true, at: 1_000 }, list(900, "rep"));
    local = reconcile(local, list(1_100, "rep"));
    expect(local[bob]).toBeUndefined();
  });

  test("a list read after the save that shows the saved role drops it too", () => {
    let local = startSave({}, bob, "manager", 1);
    local = settleSave(local, bob, 1, { ok: true, at: 1_000 }, list(900, "rep"));
    expect(reconcile(local, list(1_100, "manager"))[bob]).toBeUndefined();
  });

  test("while a save is in flight no list drops its local role", () => {
    const local = startSave({}, bob, "manager", 1);
    expect(reconcile(local, list(5_000, "manager"))[bob]?.role).toBe("manager");
    expect(reconcile(local, list(5_000, "rep"))[bob]?.role).toBe("manager");
  });

  test("a save answered after a list already read after it is dropped at once", () => {
    let local = startSave({}, bob, "manager", 1);
    local = settleSave(local, bob, 1, { ok: true, at: 1_000 }, list(1_050, "manager"));
    expect(local[bob]).toBeUndefined();
  });

  test("each row has its own saving state: one row finishing does not unlock another", () => {
    let local = startSave({}, bob, "manager", 1);
    local = startSave(local, cleo, "admin", 2);
    local = settleSave(local, bob, 1, { ok: true, at: 1_000 }, list(900, "rep"));
    expect(isSaving(local, bob)).toBe(false);
    expect(isSaving(local, cleo)).toBe(true);
    expect(local[cleo]?.role).toBe("admin");
  });

  test("an older call's answer never touches a newer save on the same row", () => {
    let local = startSave({}, bob, "manager", 1);
    local = startSave(local, bob, "admin", 2);
    local = settleSave(local, bob, 1, { ok: false }, list(900, "rep"));
    expect(local[bob]).toEqual({ role: "admin", seq: 2, savedAt: null });
    local = settleSave(local, bob, 1, { ok: true, at: 1_000 }, list(900, "rep"));
    expect(isSaving(local, bob)).toBe(true);
  });

  test("a refusal goes back to the server's role", () => {
    let local = startSave({}, bob, "manager", 1);
    local = settleSave(local, bob, 1, { ok: false }, list(900, "rep"));
    expect(local[bob]).toBeUndefined();
  });

  test("the list is read again after a save, and after a lost answer (the change may have been saved)", () => {
    expect(refreshAfter({ ok: true, at: 1 })).toBe(true);
    expect(refreshAfter({ ok: false, error: "unavailable" })).toBe(true);
    for (const error of ["step_up", "last_admin", "forbidden", "not_found", "invalid"] as const) {
      expect(refreshAfter({ ok: false, error })).toBe(false);
    }
  });
});
