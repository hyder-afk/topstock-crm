"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { verifyStepUp } from "@/app/(app)/step-up-actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { FormMessage } from "@/components/ui/form-message";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// "Confirm it's you" (step-up MFA): before an action that changes many records at once (imports today; stock
// adjustments, exports and deletes later), a fresh authenticator code is asked for when the last one is older than
// the window allows. The server says how many seconds the current code stays fresh; the browser only counts time
// elapsed since then (its own clock may be wrong).
export function useStepUp(initialSecondsLeft: number) {
  const [open, setOpen] = useState(false);
  const freshUntil = useRef(0);
  const waiting = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    freshUntil.current = performance.now() + initialSecondsLeft * 1000;
  }, [initialSecondsLeft]);

  // Resolves true when the code is fresh for at least `minSeconds` more (asking for a new one if needed), false if
  // the person cancels.
  const ensureFresh = useCallback((minSeconds = 120) => {
    if (performance.now() + minSeconds * 1000 < freshUntil.current) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      waiting.current?.(false);
      waiting.current = resolve;
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

  const dialog = <StepUpDialog open={open} onDone={(s) => finish(s)} onCancel={() => finish(null)} />;
  return { ensureFresh, requireFresh, dialog };
}

function StepUpDialog({
  open,
  onDone,
  onCancel,
}: {
  open: boolean;
  onDone: (secondsLeft: number) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("StepUp");
  const id = useId();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Each opening starts empty (adjusted during render when `open` changes, React's pattern).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setCode("");
      setError(null);
    }
  }

  const submit = async (value: string) => {
    if (busy) return;
    if (!/^\d{6}$/.test(value)) {
      setError("codeInvalid");
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    const result = await verifyStepUp(value);
    setBusy(false);
    if (result.ok) {
      onDone(result.secondsLeft);
    } else {
      setError(result.error);
      setCode("");
      inputRef.current?.focus();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onCancel())}>
      <DialogContent className="max-sm:top-auto max-sm:bottom-0 max-sm:w-full max-sm:rounded-b-none max-sm:rounded-t-[24px] max-sm:pb-[env(safe-area-inset-bottom)] sm:w-[min(440px,calc(100%-32px))]">
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
              disabled={busy}
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
            <Button type="submit" variant="neutral" disabled={busy}>
              {busy ? t("checking") : t("submit")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
