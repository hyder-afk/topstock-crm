"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

// The app's own tooltip, replacing the browser's title= bubble (Haider 15 Oct 2026: no native popups). Opens on hover
// after a short delay and at once on keyboard focus, closes on Escape, pointer leave or blur; Radix links it to the
// trigger with aria-describedby while it shows.
//
// Rules:
// - A tooltip adds a hint; it never carries the only name. Icon buttons keep their aria-label (the tooltip may repeat
//   it, e.g. with the shortcut key).
// - Only on something focusable (a button, a link), so keyboard users get it too. Not on plain text or a truncated span.
// - Never the only reason a button is disabled: say why in visible text next to it (touch screens never show tooltips,
//   and a disabled button gets no hover or focus).
// - Touch: tooltips do not open on tap, by design; nothing a phone user needs may live only in a tooltip.

export function TooltipProvider({ delayDuration = 500, skipDelayDuration = 300, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={skipDelayDuration} {...props} />;
}

export const TooltipRoot = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({ className, sideOffset = 6, collisionPadding = 16, ...props }: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "floating-content z-[60] max-w-[min(280px,calc(100vw-32px))] rounded-sm bg-primary px-2.5 py-1.5 text-xs text-primary-foreground shadow-[0_8px_24px_rgb(14_14_16/0.18)]",
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}

/**
 * `<Tooltip content={t("hint")}><button …/></Tooltip>`: the child must be one focusable element (it becomes the
 * trigger through asChild). Needs the TooltipProvider in the root layout (one for the app, so moving from one tooltip
 * to its neighbour skips the second delay).
 */
export function Tooltip({
  content,
  children,
  side = "top",
  align = "center",
  open,
  defaultOpen,
  onOpenChange,
  delayDuration,
}: {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  delayDuration?: number;
}) {
  // Nothing to say (e.g. a date not known before hydration): the child alone, no empty bubble.
  if (content === null || content === undefined || content === false || content === "") return children;
  return (
    <TooltipRoot open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange} delayDuration={delayDuration}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} align={align}>
        {content}
      </TooltipContent>
    </TooltipRoot>
  );
}
