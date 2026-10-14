"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ChevronDown } from "lucide-react";
import { changeRole } from "@/app/(app)/more/team/actions";
import { useStepUp } from "@/components/auth/step-up-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, phoneSheet } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { displayName, errorMessageKey, roles, shortId, type Person, type Role, type RoleChangeResult } from "@/lib/team";
import { cn } from "@/lib/utils";

type Ask = { person: Person; role: Role };

const noFocus = () => !document.activeElement || document.activeElement === document.body;

// The organisation's people with their roles (More > Team). Changing a role: the menu, a confirmation naming the person
// and the new role, "Confirm it's you" when the last code is older than the window, then the server action. The row
// shows the new role at once and goes back if the database refuses; the result is announced, and the focus comes back
// to that row's role button.
export function TeamList({
  people,
  created,
  me,
  stepUpSeconds,
}: {
  people: Person[];
  created: Record<string, string>;
  me: string;
  stepUpSeconds: number;
}) {
  const t = useTranslations("Team");
  const router = useRouter();
  const stepUp = useStepUp(stepUpSeconds, "bodyRole");
  // Roles set here that the server data does not show yet (saving, or saved before the next refresh). The page can be
  // drawn again by the server at any moment, for instance after "Confirm it's you" renews the session cookies, so a
  // local role is dropped only once the server data shows that role (React's adjust-during-render pattern).
  const [local, setLocal] = useState<Record<string, Role>>({});
  const [base, setBase] = useState(people);
  if (base !== people) {
    setBase(people);
    setLocal((l) => Object.fromEntries(Object.entries(l).filter(([id, r]) => people.some((p) => p.id === id && p.role !== r))));
  }
  const unset = (id: string) => setLocal((l) => Object.fromEntries(Object.entries(l).filter(([k]) => k !== id)));
  const [pending, setPending] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [asking, setAsking] = useState<Ask | null>(null);
  // What the dialog shows; kept while it closes so its words do not vanish during the exit.
  const [shown, setShown] = useState<Ask | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const lastRow = useRef<string | null>(null);

  const who = useCallback((p: Person) => displayName(p) || t("account", { id: shortId(p.id) }), [t]);

  // The same words twice in a row are announced again (cleared first, set on the next frame).
  const announce = useCallback((text: string) => {
    setAnnouncement("");
    requestAnimationFrame(() => setAnnouncement(text));
  }, []);

  const focusRow = useCallback((id: string) => {
    const el = triggers.current.get(id);
    if (el?.isConnected && (noFocus() || document.activeElement === el)) el.focus();
  }, []);

  const ask = (person: Person, role: Role) => {
    lastRow.current = person.id;
    setShown({ person, role });
    setAsking({ person, role });
  };

  const apply = async ({ person, role }: Ask) => {
    const row = () => triggers.current.get(person.id) ?? null;
    if (!(await stepUp.ensureFresh(60, row))) {
      announce(t("announce.cancelled"));
      focusRow(person.id);
      return;
    }
    setLocal((l) => ({ ...l, [person.id]: role }));
    setRowError((e) => ({ ...e, [person.id]: "" }));
    setPending(person.id);
    announce(t("announce.saving", { who: who(person) }));
    const call = async (): Promise<RoleChangeResult> => {
      try {
        return await changeRole({ userId: person.id, role });
      } catch {
        // The call itself failed (connection lost, or the app was updated meanwhile).
        return { ok: false, error: "unavailable" };
      }
    };
    let result = await call();
    // The database judged the code stale (a clock or a slow answer): ask for one now, then try once more.
    if (!result.ok && result.error === "step_up") {
      result = (await stepUp.requireFresh()) ? await call() : result;
    }
    setPending(null);
    if (result.ok) {
      if (person.id === me && role !== "admin") {
        announce(t("announce.savedSelf", { role }));
        // The admin screens are gone for this person: back to More, drawn again without the Team row.
        router.replace("/more");
        router.refresh();
        return;
      }
      announce(t("announce.saved", { who: who(person), role }));
      // The server's list catches up; the local role stays shown until it does.
      router.refresh();
    } else {
      unset(person.id);
      const text =
        result.error === "step_up" ? t("announce.cancelled") : t(`errors.${errorMessageKey(result.error, person.id === me)}`, { who: who(person) });
      setRowError((e) => ({ ...e, [person.id]: result.error === "step_up" ? "" : text }));
      announce(text);
    }
    focusRow(person.id);
  };

  return (
    <section aria-labelledby="team-people" className="flex flex-col gap-3">
      <h2 id="team-people" className="text-lg font-bold">
        {t("count", { count: people.length })}
      </h2>
      <ul className="flex flex-col overflow-hidden rounded-lg bg-card">
        {people.map((p) => {
          const name = displayName(p);
          const role = local[p.id] ?? p.role;
          const error = rowError[p.id];
          return (
            <li key={p.id} className="border-b border-border last:border-b-0">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4 sm:px-6">
                <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {name ? (
                      <span className="font-bold break-words" translate="no">
                        {name}
                      </span>
                    ) : (
                      <span className="font-bold text-muted-foreground">{t("noName")}</span>
                    )}
                    {p.id === me ? (
                      <span className="rounded-sm bg-muted px-2 py-0.5 text-xs font-bold">{t("you")}</span>
                    ) : null}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {name ? null : (
                      <>
                        <span>
                          {t.rich("userId", {
                            id: shortId(p.id),
                            mono: (chunks) => (
                              <span className="font-mono" translate="no">
                                {chunks}
                              </span>
                            ),
                          })}
                        </span>
                        <span aria-hidden="true"> · </span>
                      </>
                    )}
                    {t("created", { date: created[p.id] ?? "" })}
                  </p>
                  {name ? null : <p className="max-w-[60ch] text-sm text-muted-foreground">{t("noNameHint")}</p>}
                  {error ? (
                    <p id={`role-error-${p.id}`} className="max-w-[60ch] text-sm text-status-red">
                      {error}
                    </p>
                  ) : null}
                </div>
                <p className="hidden w-[36ch] text-sm text-muted-foreground xl:block">{t(`roleDescription.${role}`)}</p>
                <RoleMenu
                  role={role}
                  label={t("roleMenu", { who: who(p), role: t(`role.${role}`) })}
                  busy={pending === p.id}
                  describedBy={error ? `role-error-${p.id}` : undefined}
                  triggerRef={(el) => {
                    if (el) triggers.current.set(p.id, el);
                    else triggers.current.delete(p.id);
                  }}
                  onPick={(next) => ask(p, next)}
                />
              </div>
            </li>
          );
        })}
      </ul>
      <p role="status" className="sr-only">
        {announcement}
      </p>

      <Dialog
        open={asking !== null}
        onOpenChange={(open) => {
          if (open) return;
          setAsking(null);
          announce(t("announce.cancelled"));
        }}
      >
        <DialogContent
          className={cn(phoneSheet, "sm:w-[min(480px,calc(100%-32px))]")}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // Back to the row's role button, unless the next step ("Confirm it's you") already has the focus.
            if (lastRow.current) focusRow(lastRow.current);
          }}
        >
          {shown ? (
            <form
              className="flex flex-col gap-5 p-6"
              onSubmit={(event) => {
                event.preventDefault();
                if (!asking) return;
                const next = asking;
                setAsking(null);
                void apply(next);
              }}
            >
              <div className="flex flex-col gap-2">
                <DialogTitle className="text-xl font-bold tracking-[-0.03em] text-balance">{t("confirm.title")}</DialogTitle>
                <DialogDescription className="text-pretty">
                  <span className="font-bold">{t("confirm.body", { who: who(shown.person), role: shown.role })}</span>{" "}
                  <span className="text-muted-foreground">{t(`roleDescription.${shown.role}`)}</span>
                </DialogDescription>
              </div>
              {shown.person.id === me && shown.role !== "admin" ? (
                <p className="flex items-start gap-3 rounded-md bg-muted p-3 text-sm">
                  <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-status-amber" />
                  <span>{t("confirm.self")}</span>
                </p>
              ) : null}
              <p className="text-sm text-muted-foreground">{t("confirm.code")}</p>
              <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <Button
                  variant="quiet"
                  onClick={() => {
                    setAsking(null);
                    announce(t("announce.cancelled"));
                  }}
                >
                  {t("confirm.cancel")}
                </Button>
                <Button type="submit" variant="neutral">
                  {t("confirm.submit")}
                </Button>
              </div>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
      {stepUp.dialog}
    </section>
  );
}

// One row's role button and menu: the three roles with what each may do. Locked (not disabled, so the focus stays on
// it) while that row's change is being saved.
function RoleMenu({
  role,
  label,
  busy,
  describedBy,
  triggerRef,
  onPick,
}: {
  role: Role;
  label: string;
  busy: boolean;
  describedBy?: string;
  triggerRef: (el: HTMLButtonElement | null) => void;
  onPick: (role: Role) => void;
}) {
  const t = useTranslations("Team");
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={(next) => setOpen(next && !busy)}>
      <DropdownMenuTrigger
        ref={triggerRef}
        aria-label={label}
        aria-describedby={describedBy}
        aria-disabled={busy || undefined}
        aria-busy={busy || undefined}
        className={cn(
          buttonVariants({ variant: "quiet" }),
          "min-h-11 min-w-36 justify-between px-4 text-sm transition-[opacity,transform] duration-150",
          busy && "opacity-60",
        )}
      >
        {t(`role.${role}`)}
        <ChevronDown aria-hidden="true" strokeWidth={1.75} className="size-4 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(340px,calc(100vw-32px))]">
        <DropdownMenuRadioGroup
          value={role}
          onValueChange={(v) => {
            const next = roles.find((r) => r === v);
            if (!next || next === role) return;
            // After the menu has closed and given the focus back (a dialog opened from inside it would lose it).
            window.setTimeout(() => onPick(next), 0);
          }}
        >
          {roles.map((r) => (
            <DropdownMenuRadioItem key={r} value={r} className="py-2">
              <span className="flex flex-col gap-0.5">
                <span className="font-bold">{t(`role.${r}`)}</span>
                <span className="text-xs text-muted-foreground">{t(`roleDescription.${r}`)}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The list could not be read: try again without leaving the page. When the list replaces this block, the focus goes to
// the page title instead of falling to the page body.
export function RetryButton({ label }: { label: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const pressed = useRef(false);
  useEffect(
    () => () => {
      if (!pressed.current) return;
      requestAnimationFrame(() => {
        if (noFocus()) document.getElementById("team-title")?.focus();
      });
    },
    [],
  );
  return (
    <Button
      variant="neutral"
      aria-disabled={pending || undefined}
      onClick={() => {
        if (pending) return;
        pressed.current = true;
        startTransition(() => router.refresh());
      }}
    >
      {label}
    </Button>
  );
}
