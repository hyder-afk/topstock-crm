import type { LucideIcon } from "lucide-react";

// What a section shows before it has anything in it: what will appear here, in one calm sentence.
export function EmptyState({ icon: Icon, title, body }: { icon: LucideIcon; title: string; body: string }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg bg-card p-6 sm:p-8">
      <span className="grid size-11 place-items-center rounded-md bg-muted text-muted-foreground">
        <Icon aria-hidden="true" strokeWidth={1.75} className="size-[22px]" />
      </span>
      <h2 className="text-xl font-bold">{title}</h2>
      <p className="max-w-[60ch] text-muted-foreground">{body}</p>
    </div>
  );
}

// Skeleton with the same shape (no spinners).
export function EmptyStateSkeleton() {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg bg-card p-6 sm:p-8">
      <div className="size-11 rounded-md bg-muted motion-safe:animate-pulse" />
      <div className="h-7 w-48 rounded-sm bg-muted motion-safe:animate-pulse" />
      <div className="h-6 w-full max-w-md rounded-sm bg-muted motion-safe:animate-pulse" />
    </div>
  );
}
