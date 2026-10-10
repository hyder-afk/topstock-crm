"use client";

import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

// A progress bar (no spinners). Determinate: the fill grows with a scaleX spring (transform only), and jumps instead
// under reduced motion. With no value (work whose length is unknown, like "Looking for duplicates…") it reports no
// number and the empty track pulses softly, so it never looks finished while work is still going on.
export function ProgressBar({ value, max, label, className }: { value: number | null; max: number; label: string; className?: string }) {
  const reduce = useReducedMotion();
  if (value === null) {
    return (
      <div role="progressbar" aria-label={label} className={cn("h-2 w-full rounded-full bg-muted motion-safe:animate-pulse", className)} />
    );
  }
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(value, max)}
      className={cn("h-2 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      <motion.div
        className="h-full w-full origin-left rounded-full bg-foreground"
        initial={false}
        animate={{ scaleX: ratio }}
        transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 170, damping: 30 }}
      />
    </div>
  );
}
