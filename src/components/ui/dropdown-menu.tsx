"use client";

import * as Menu from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

// Menus: keyboard (arrows, typeahead, Escape) and focus return come from Radix; items are 44 px tall on touch.
export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuGroup = Menu.Group;
export const DropdownMenuRadioGroup = Menu.RadioGroup;

export function DropdownMenuContent({ className, align = "end", sideOffset = 8, ...props }: React.ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={16}
        className={cn(
          "floating-content z-40 max-h-[min(70vh,420px)] min-w-[220px] overflow-y-auto rounded-lg border border-border bg-card p-1.5 text-foreground shadow-[0_16px_40px_rgb(14_14_16/0.18)] focus:outline-none",
          className,
        )}
        {...props}
      />
    </Menu.Portal>
  );
}

const item =
  "relative flex min-h-11 cursor-pointer select-none items-center gap-3 rounded-md px-3 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted sm:min-h-9";

export function DropdownMenuItem({ className, ...props }: React.ComponentProps<typeof Menu.Item>) {
  return <Menu.Item className={cn(item, className)} {...props} />;
}

export function DropdownMenuCheckboxItem({ className, children, ...props }: React.ComponentProps<typeof Menu.CheckboxItem>) {
  return (
    <Menu.CheckboxItem className={cn(item, "pl-9", className)} {...props}>
      <Menu.ItemIndicator className="absolute left-3 grid size-4 place-items-center">
        <Check aria-hidden="true" strokeWidth={2} className="size-4" />
      </Menu.ItemIndicator>
      {children}
    </Menu.CheckboxItem>
  );
}

export function DropdownMenuRadioItem({ className, children, ...props }: React.ComponentProps<typeof Menu.RadioItem>) {
  return (
    <Menu.RadioItem className={cn(item, "pl-9", className)} {...props}>
      <Menu.ItemIndicator className="absolute left-3 grid size-4 place-items-center">
        <Check aria-hidden="true" strokeWidth={2} className="size-4" />
      </Menu.ItemIndicator>
      {children}
    </Menu.RadioItem>
  );
}

export function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof Menu.Label>) {
  return <Menu.Label className={cn("px-3 pt-2 pb-1 text-xs font-bold text-muted-foreground", className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof Menu.Separator>) {
  return <Menu.Separator className={cn("my-1.5 h-px bg-border", className)} {...props} />;
}
