import { cn } from "@/lib/utils";

// A determinate progress bar (no spinners): the fill grows with transform only, and the reduced-motion rules in
// globals.css make it jump instead of glide.
export function ProgressBar({ value, max, label, className }: { value: number; max: number; label: string; className?: string }) {
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
      <div
        className="h-full w-full origin-left rounded-full bg-foreground transition-transform duration-300 ease-out"
        style={{ transform: `scaleX(${ratio})` }}
      />
    </div>
  );
}
