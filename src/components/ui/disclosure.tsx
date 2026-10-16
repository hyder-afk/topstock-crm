import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

// The app's own disclosure (Haider 15 Oct 2026: no native pickers or popups). A <details>/<summary> pair keeps the
// browser's free keyboard and screen-reader behaviour (Enter/Space toggles, "collapsed"/"expanded"), but never shows
// the browser's triangle: the marker is hidden here and in globals.css, and our own chevron turns on open (transform
// only; instant under prefers-reduced-motion). Raw <summary> outside src/components/ui fails the native-controls check.
export function Disclosure({
  summary,
  children,
  className,
  summaryClassName,
  ...props
}: Omit<React.ComponentProps<"details">, "children"> & {
  summary: React.ReactNode;
  children: React.ReactNode;
  summaryClassName?: string;
}) {
  return (
    <details className={cn("group", className)} {...props}>
      <summary
        className={cn(
          "flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 text-sm font-bold hover:[&>svg]:text-foreground [&::-webkit-details-marker]:hidden",
          summaryClassName,
        )}
      >
        <span className="min-w-0">{summary}</span>
        <ChevronDown
          aria-hidden="true"
          strokeWidth={2}
          className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
        />
      </summary>
      {children}
    </details>
  );
}
