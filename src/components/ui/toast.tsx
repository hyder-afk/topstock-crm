"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

type Toast = { id: number; message: string; action?: { label: string; run: () => void }; duration: number; quiet: boolean };
/** `quiet`: shown but not read out (the page already said it in its own live message). */
type ToastOptions = { duration?: number; quiet?: boolean };
type ToastApi = { show: (message: string, action?: Toast["action"], options?: ToastOptions) => void };

const ToastContext = createContext<ToastApi>({ show: () => {} });

const boxClass =
  "flex max-w-[min(560px,100%)] items-center gap-2 rounded-lg bg-primary py-2 pr-2 pl-4 text-sm text-primary-foreground shadow-[0_12px_32px_rgb(14_14_16/0.24)]";
const actionClass = "min-h-11 rounded-md px-3 font-bold sm:min-h-9";
const dismissClass = "grid size-11 place-items-center rounded-md sm:size-9";
export const useToast = () => useContext(ToastContext);

// One message at a time, above the dock, announced politely. Stays 6 s by default (a logged call's Undo: 10 s; longer
// while hovered or focused) so there is time to press Undo. It rises in and, on timeout, Undo or ✕, sinks back the
// way it came (Apple audit #9): a copy stays drawn for the 140 ms exit, out of the live region, hidden from assistive
// tech and inert; a new toast replaces it at once. Reduced motion: gone at once (the global block).
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations("Common");
  const [toast, setToast] = useState<Toast | null>(null);
  const [leaving, setLeaving] = useState<Toast | null>(null);
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
    setLeaving(null);
    setToast({ id: seq.current, message, action, duration: options?.duration ?? 6000, quiet: options?.quiet ?? false });
  }, []);
  // The toast on screen goes: it leaves with its exit.
  const hide = useCallback((cur: Toast) => {
    setToast((now) => (now?.id === cur.id ? null : now));
    setLeaving(cur);
  }, []);

  useEffect(() => {
    if (!toast || paused) return;
    const timer = window.setTimeout(() => hide(toast), toast.duration);
    return () => window.clearTimeout(timer);
  }, [toast, paused, hide]);
  // The leaving copy goes when its exit ends (animationend), or after 400 ms if no animation runs.
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setLeaving((cur) => (cur?.id === leaving.id ? null : cur)), 400);
    return () => window.clearTimeout(timer);
  }, [leaving]);

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
      className={cn(boxClass, "animate-page pointer-events-auto")}
    >
      <span className="min-w-0 flex-1">{toast.message}</span>
      {toast.action ? (
        <button
          type="button"
          onClick={(e) => {
            const fromKeyboard = e.currentTarget.matches(":focus-visible");
            toast.action?.run();
            hide(toast);
            const back = returnTo.current;
            returnTo.current = null;
            if (fromKeyboard && back?.isConnected) requestAnimationFrame(() => back.focus({ preventScroll: true }));
          }}
          className={cn(actionClass, "underline-offset-4 transition-transform duration-150 hover:underline active:scale-[0.97]")}
        >
          {toast.action.label}
        </button>
      ) : null}
      <button
        type="button"
        aria-label={t("dismiss")}
        onClick={() => hide(toast)}
        className={cn(dismissClass, "opacity-80 transition-[opacity,transform,scale] duration-150 hover:opacity-100 active:scale-[0.97]")}
      >
        <X aria-hidden="true" strokeWidth={1.75} className="size-4" />
      </button>
    </div>
  ) : null;
  const place = "pointer-events-none fixed inset-x-0 bottom-[calc(104px+env(safe-area-inset-bottom,0px))] z-40 flex justify-center px-4";
  // The leaving copy: the same box, without its controls' behaviour, sinking 8 px and fading (transform and opacity).
  const gone = leaving && !toast ? (
    <div
      key={leaving.id}
      data-toast-leaving=""
      aria-hidden="true"
      inert
      onAnimationEnd={() => setLeaving((cur) => (cur?.id === leaving.id ? null : cur))}
      className={cn(boxClass, "animate-toast-out")}
    >
      <span className="min-w-0 flex-1">{leaving.message}</span>
      {leaving.action ? <span className={cn(actionClass, "inline-flex items-center")}>{leaving.action.label}</span> : null}
      <span className={cn(dismissClass, "opacity-80")}>
        <X aria-hidden="true" strokeWidth={1.75} className="size-4" />
      </span>
    </div>
  ) : null;
  // A quiet toast is drawn outside the live region, so it is seen and not read out.
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div role="status" aria-live="polite" className={place}>
        {toast && !toast.quiet ? box : null}
      </div>
      {toast?.quiet ? <div className={place}>{box}</div> : null}
      {gone ? <div className={place}>{gone}</div> : null}
    </ToastContext.Provider>
  );
}
