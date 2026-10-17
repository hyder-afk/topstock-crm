"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { X } from "lucide-react";

type Toast = { id: number; message: string; action?: { label: string; run: () => void }; duration: number; quiet: boolean };
/** `quiet`: shown but not read out (the page already said it in its own live message). */
type ToastOptions = { duration?: number; quiet?: boolean };
type ToastApi = { show: (message: string, action?: Toast["action"], options?: ToastOptions) => void };

const ToastContext = createContext<ToastApi>({ show: () => {} });
export const useToast = () => useContext(ToastContext);

// One message at a time, above the dock, announced politely. Stays 6 s by default (a logged call's Undo: 10 s; longer
// while hovered or focused) so there is time to press Undo.
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations("Common");
  const [toast, setToast] = useState<Toast | null>(null);
  // The toast the pointer or the focus is on (its timer waits). Kept by id: pressing Undo or Dismiss removes the box
  // under the pointer, so no mouseleave or blur ever comes, and a plain flag stayed on and froze every later toast.
  const [pausedId, setPausedId] = useState<number | null>(null);
  const paused = toast !== null && pausedId === toast.id;
  const seq = useRef(0);
  // Where the focus was before it entered the toast: an action pressed from the keyboard unmounts the toast with its
  // focused button, so the focus goes back there instead of to the top of the page.
  const returnTo = useRef<HTMLElement | null>(null);

  const show = useCallback<ToastApi["show"]>((message, action, options) => {
    seq.current += 1;
    setToast({ id: seq.current, message, action, duration: options?.duration ?? 6000, quiet: options?.quiet ?? false });
  }, []);

  useEffect(() => {
    if (!toast || paused) return;
    const timer = window.setTimeout(() => setToast((cur) => (cur?.id === toast.id ? null : cur)), toast.duration);
    return () => window.clearTimeout(timer);
  }, [toast, paused]);

  const api = useMemo(() => ({ show }), [show]);
  const box = toast ? (
    <div
      key={toast.id}
      data-toast=""
      onMouseEnter={() => setPausedId(toast.id)}
      onMouseLeave={() => setPausedId(null)}
      onFocus={(e) => {
        setPausedId(toast.id);
        const from = e.relatedTarget;
        if (from instanceof HTMLElement && !e.currentTarget.contains(from)) returnTo.current = from;
      }}
      onBlur={() => setPausedId(null)}
      className="animate-page pointer-events-auto flex max-w-[min(560px,100%)] items-center gap-2 rounded-lg bg-primary py-2 pr-2 pl-4 text-sm text-primary-foreground shadow-[0_12px_32px_rgb(14_14_16/0.24)]"
    >
      <span className="min-w-0 flex-1">{toast.message}</span>
      {toast.action ? (
        <button
          type="button"
          onClick={(e) => {
            const fromKeyboard = e.currentTarget.matches(":focus-visible");
            toast.action?.run();
            setToast(null);
            const back = returnTo.current;
            returnTo.current = null;
            if (fromKeyboard && back?.isConnected) requestAnimationFrame(() => back.focus({ preventScroll: true }));
          }}
          className="min-h-11 rounded-md px-3 font-bold underline-offset-4 transition-transform duration-150 hover:underline active:scale-[0.97] sm:min-h-9"
        >
          {toast.action.label}
        </button>
      ) : null}
      <button
        type="button"
        aria-label={t("dismiss")}
        onClick={() => setToast(null)}
        className="grid size-11 place-items-center rounded-md opacity-80 transition-[opacity,transform] duration-150 hover:opacity-100 active:scale-[0.97] sm:size-9"
      >
        <X aria-hidden="true" strokeWidth={1.75} className="size-4" />
      </button>
    </div>
  ) : null;
  const place = "pointer-events-none fixed inset-x-0 bottom-[calc(104px+env(safe-area-inset-bottom,0px))] z-40 flex justify-center px-4";
  // A quiet toast is drawn outside the live region, so it is seen and not read out.
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div role="status" aria-live="polite" className={place}>
        {toast && !toast.quiet ? box : null}
      </div>
      {toast?.quiet ? <div className={place}>{box}</div> : null}
    </ToastContext.Provider>
  );
}
