"use client";

import { useTranslations } from "next-intl";
import { useDroppable } from "@dnd-kit/core";
import { motion, useReducedMotion } from "motion/react";
import { springs } from "@/lib/motion";
import { cn } from "@/lib/utils";

// The Lost band (Day 5 design 7.3): shown only while a deal is dragged, fixed above the dock, min(560 px, 100% - 32 px)
// wide. Dropping here opens the Lose dialog. It enters with the snappy spring; no colour accent (over: the muted
// surface and a heavier border).
export function LostBand() {
  const t = useTranslations("Pipeline");
  const reduce = useReducedMotion();
  const { setNodeRef, isOver } = useDroppable({ id: "lost" });
  return (
    <motion.div
      ref={setNodeRef}
      data-lost-band
      data-over={isOver || undefined}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, y: 24 }}
      transition={reduce ? { duration: 0.12 } : springs.snappy}
      className={cn(
        "fixed inset-x-0 bottom-[calc(104px+env(safe-area-inset-bottom,0px))] z-40 mx-auto flex min-h-16 w-[min(560px,calc(100%-32px))] items-center justify-center rounded-lg border-2 border-dashed px-4 text-sm font-bold",
        isOver ? "border-foreground bg-muted text-foreground" : "border-border bg-card/95 text-muted-foreground",
      )}
    >
      {t("lostBand")}
    </motion.div>
  );
}
