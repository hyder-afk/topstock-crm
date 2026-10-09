"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";

// shadcn-style dialog on TopStock tokens. A floating layer: shadow allowed, solid card (DESIGN.md), opacity + scale
// entrance only, focus trapped and returned by Radix.
export const Dialog = DialogPrimitive.Root;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({ className, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="dialog-overlay fixed inset-0 z-50 bg-[rgb(14_14_16/0.4)]" />
      <DialogPrimitive.Content
        // The panel itself only takes focus programmatically (tabindex -1), so its outline is suppressed; the focused
        // control inside shows the ring.
        className={cn(
          "dialog-content fixed inset-x-0 top-[12vh] z-50 focus:outline-none mx-auto w-[min(640px,calc(100%-32px))] overflow-hidden rounded-xl border border-border bg-card text-foreground shadow-[0_24px_64px_rgb(14_14_16/0.28)]",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
