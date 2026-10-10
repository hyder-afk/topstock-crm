import { useTranslations } from "next-intl";
import { statusTone, type LeadStatus } from "@/lib/leads";
import { cn } from "@/lib/utils";

const dot = {
  neutral: "bg-muted-foreground",
  amber: "bg-status-amber",
  green: "bg-status-green",
  red: "bg-status-red",
} as const;

// A labelled badge: the word carries the meaning, the small dot only adds a hint of colour (DESIGN.md).
export function StatusBadge({ status, className }: { status: LeadStatus; className?: string }) {
  const t = useTranslations("Leads.status");
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-sm bg-muted px-2 py-0.5 text-xs whitespace-nowrap text-foreground",
        className,
      )}
    >
      <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", dot[statusTone[status]])} />
      <span className="truncate">{t(status)}</span>
    </span>
  );
}
