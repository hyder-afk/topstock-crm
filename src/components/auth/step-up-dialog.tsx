"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { verifyStepUp, type StepUpResult } from "@/app/(app)/step-up-actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, phoneSheet } from "@/components/ui/dialog";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type StepUpError = Extract<StepUpResult, { ok: false }>["error"];

// "Confirm it's you" (step-up MFA): before an action that changes many records at once (imports today; stock
// adjustments, exports and deletes later), a fresh authenticator code is asked for when the last one is older than
// the window allows. The server says how many seconds the current code stays fresh; the browser only counts time
// elapsed since then (its own clock may be wrong).
export function useStepUp(initialSecondsLeft: number) {
  const [open, setOpen] = useState(false);
  const freshUntil = useRef(0);
  const waiting = useRef<((ok: boolean) => void) | null>(null);
  // What had focus when the dialog opened: it gets focus back on close unless the action moved it on.
  const opener = useRef<HTMLElement | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    freshUntil.current = performance.now() + initialSecondsLeft * 1000;
  }, [initialSecondsLeft]);

  // When the page that asked is left, nobody can answer the dialog any more: a waiting action stops (as if cancelled)
  // instead of waiting for ever.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      waiting.current?.(false);
      waiting.current = null;
    };
  }, []);

  // Resolves true when the code is fresh for at least `minSeconds` more (asking for a new one if needed), false if
  // the person cancels.
  const ensureFresh = useCallback((minSeconds = 120) => {
    if (performance.now() + minSeconds * 1000 < freshUntil.current) return Promise.resolve(true);
    if (!mounted.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      waiting.current?.(false);
      waiting.current = resolve;
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOpen(true);
    });
  }, []);

  // An action answered "step_up" (the database judged the code stale): ask now.
  const requireFresh = useCallback(() => {
    freshUntil.current = 0;
    return ensureFresh();
  }, [ensureFresh]);

  const finish = useCallback((secondsLeft: number | null) => {
    if (secondsLeft !== null) freshUntil.current = performance.now() + secondsLeft * 1000;
    setOpen(false);
    waiting.current?.(secondsLeft !== null);
    waiting.current = null;
  }, []);

  // Radix would send focus to a trigger this dialog does not have (so to the page body): give it back to what had it,
  // unless the action that continued has already moved it (to the next step's heading, for example).
  const restoreFocus = useCallback(() => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const target = opener.current;
    if (target?.isConnected && !target.matches(":disabled")) target.focus();
  }, []);

  const dialog = <StepUpDialog open={open} onDone={(s) => finish(s)} onCancel={() => finish(null)} onRestoreFocus={restoreFocus} />;
  return { ensureFresh, requireFresh, dialog };
}

function StepUpDialog({
  open,
  onDone,
  onCancel,
  onRestoreFocus,
}: {
  open: boolean;
  onDone: (secondsLeft: number) => void;
  onCancel: () => void;
  onRestoreFocus: () => void;
}) {
  const t = useTranslations("StepUp");
  const id = useId();
  const [code, setCode] = useState("");
  const [error, setError] = useState<StepUpError | null>(null);
  const [busy, setBusy] = useState(false);
  // Counts refused codes: each one sends the focus back to the field.
  const [refused, setRefused] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Each opening starts empty and ready to type (adjusted during render when `open` changes, React's pattern).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setCode("");
      setError(null);
      setBusy(false);
    }
  }

  // After a refused code the field takes focus again once the check is over (after React has drawn it), so the next
  // code can be typed at once.
  useEffect(() => {
    if (refused > 0 && !busy) inputRef.current?.focus();
  }, [refused, busy]);

  const submit = async (value: string) => {
    if (busy) return;
    if (!/^\d{6}$/.test(value)) {
      setError("codeInvalid");
      setRefused((n) => n + 1);
      return;
    }
    setBusy(true);
    setError(null);
    let result: StepUpResult;
    try {
      result = await verifyStepUp(value);
    } catch {
      // The call itself failed (connection lost, or the app was updated meanwhile).
      result = { ok: false, error: "unavailable" };
    } finally {
      setBusy(false);
    }
    if (result.ok) {
      onDone(result.secondsLeft);
    } else {
      setError(result.error);
      setCode("");
      setRefused((n) => n + 1);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onCancel())}>
      <DialogContent
        className={cn(phoneSheet, "sm:w-[min(440px,calc(100%-32px))]")}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRestoreFocus();
        }}
      >
        <form
          className="flex flex-col gap-5 p-6"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(code);
          }}
        >
          <div className="flex flex-col gap-2">
            <DialogTitle className="text-xl font-bold tracking-[-0.03em] text-balance">{t("title")}</DialogTitle>
            <DialogDescription className="text-muted-foreground">{t("body")}</DialogDescription>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={id}>{t("codeLabel")}</Label>
            {/* Read-only (not disabled) while checking: a disabled field would drop the keyboard focus to the page. */}
            <Input
              ref={inputRef}
              id={id}
              name="code"
              value={code}
              onChange={(event) => {
                const digits = event.target.value.replace(/\D/g, "").slice(0, 6);
                setCode(digits);
                if (digits.length === 6) void submit(digits);
              }}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              spellCheck={false}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
              aria-busy={busy || undefined}
              readOnly={busy}
              className="font-mono text-2xl tracking-[0.3em]"
            />
            {error ? (
              <FormMessage id={`${id}-error`} tone="error">
                {t(`errors.${error}`)}
              </FormMessage>
            ) : null}
          </div>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="quiet" onClick={onCancel}>
              {t("cancel")}
            </Button>
            <Button type="submit" variant="neutral" aria-disabled={busy || undefined}>
              {busy ? t("checking") : t("submit")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
