import { cn } from "@/lib/utils";

// A key cap, e.g. <Kbd>G</Kbd><Kbd>L</Kbd>. DM Mono so keys line up.
export function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "inline-grid h-6 min-w-6 place-items-center rounded-sm border border-border bg-muted px-1.5 font-mono text-xs text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
