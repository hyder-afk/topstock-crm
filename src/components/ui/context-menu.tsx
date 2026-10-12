"use client";

import * as Menu from "@radix-ui/react-context-menu";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

// Right-click menus at the pointer (CLAUDE.md: context menus), on the same tokens as the dropdown menu: Radix gives the
// keyboard (arrows, typeahead, Escape, submenus with the right arrow) and returns the focus. Items are 44 px tall on touch.
export const ContextMenu = Menu.Root;
export const ContextMenuTrigger = Menu.Trigger;
export const ContextMenuSub = Menu.Sub;
export const ContextMenuGroup = Menu.Group;

const panel =
  "floating-content z-[60] max-h-[min(70vh,420px)] min-w-[220px] overflow-y-auto rounded-lg border border-border bg-card p-1.5 text-foreground shadow-[0_16px_40px_rgb(14_14_16/0.18)] focus:outline-none";
const item =
  "relative flex min-h-11 cursor-pointer select-none items-center gap-3 rounded-md px-3 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted sm:min-h-9";

export function ContextMenuContent({ className, ...props }: React.ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content collisionPadding={16} className={cn(panel, "[transform-origin:var(--radix-context-menu-content-transform-origin)]", className)} {...props} />
    </Menu.Portal>
  );
}

export function ContextMenuItem({ className, ...props }: React.ComponentProps<typeof Menu.Item>) {
  return <Menu.Item className={cn(item, className)} {...props} />;
}

export function ContextMenuSubTrigger({ className, children, ...props }: React.ComponentProps<typeof Menu.SubTrigger>) {
  return (
    <Menu.SubTrigger className={cn(item, "data-[state=open]:bg-muted", className)} {...props}>
      {children}
      <ChevronRight aria-hidden="true" strokeWidth={1.75} className="ml-auto size-4" />
    </Menu.SubTrigger>
  );
}

export function ContextMenuSubContent({ className, ...props }: React.ComponentProps<typeof Menu.SubContent>) {
  return (
    <Menu.Portal>
      <Menu.SubContent collisionPadding={16} className={cn(panel, className)} {...props} />
    </Menu.Portal>
  );
}

export function ContextMenuSeparator({ className, ...props }: React.ComponentProps<typeof Menu.Separator>) {
  return <Menu.Separator className={cn("my-1.5 h-px bg-border", className)} {...props} />;
}
