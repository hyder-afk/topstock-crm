"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { X } from "lucide-react";

type Toast = { id: number; message: string; action?: { label: string; run: () => void } };
type ToastApi = { show: (message: string, action?: Toast["action"]) => void };

const ToastContext = createContext<ToastApi>({ show: () => {} });
export const useToast = () => useContext(ToastContext);

// One message at a time, above the dock, announced politely. Stays 6 s (longer while hovered or focused) so there
// is time to press Undo.
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations("Common");
  const [toast, setToast] = useState<Toast | null>(null);
  const [paused, setPaused] = useState(false);
  const seq = useRef(0);

  const show = useCallback<ToastApi["show"]>((message, action) => {
    seq.current += 1;
    setToast({ id: seq.current, message, action });
  }, []);

  useEffect(() => {
    if (!toast || paused) return;
    const timer = window.setTimeout(() => setToast((cur) => (cur?.id === toast.id ? null : cur)), 6000);
    return () => window.clearTimeout(timer);
  }, [toast, paused]);

  const api = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(104px+env(safe-area-inset-bottom,0px))] z-40 flex justify-center px-4"
      >
        {toast ? (
          <div
            key={toast.id}
            onMouseEnter={() => setPaused(true)}
            onMouseLeave={() => setPaused(false)}
            onFocus={() => setPaused(true)}
            onBlur={() => setPaused(false)}
            className="animate-page pointer-events-auto flex max-w-[min(560px,100%)] items-center gap-2 rounded-lg bg-primary py-2 pr-2 pl-4 text-sm text-primary-foreground shadow-[0_12px_32px_rgb(14_14_16/0.24)]"
          >
            <span className="min-w-0 flex-1">{toast.message}</span>
            {toast.action ? (
              <button
                type="button"
                onClick={() => {
                  toast.action?.run();
                  setToast(null);
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
        ) : null}
      </div>
    </ToastContext.Provider>
  );
}
