import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

// Native select on our tokens: the platform picker on phones, full keyboard support everywhere.
export function Select({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <span className="relative block">
      <select
        className={cn(
          "min-h-11 w-full appearance-none rounded-md border border-border bg-background py-2 pr-10 pl-3 text-base text-foreground",
          "aria-invalid:border-status-red disabled:opacity-60",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        strokeWidth={1.75}
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </span>
  );
}
