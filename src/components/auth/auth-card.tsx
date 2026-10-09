// The one card every sign-in step uses, so they share width, rhythm and heading level.
export function AuthCard({ title, body, children }: { title: string; body?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex w-full max-w-[420px] flex-col gap-6 rounded-lg bg-card p-6 sm:p-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold">{title}</h1>
        {body ? <p className="text-muted-foreground">{body}</p> : null}
      </div>
      {children}
    </section>
  );
}

// Skeleton with the same card, used by each sign-in route's loading.tsx (no spinners).
export function AuthCardSkeleton({ label, fields = 2 }: { label: string; fields?: number }) {
  return (
    <section aria-busy="true" className="flex w-full max-w-[420px] flex-col gap-6 rounded-lg bg-card p-6 sm:p-8">
      <span className="sr-only">{label}</span>
      <div className="flex flex-col gap-2">
        <div className="h-9 w-2/3 rounded-sm bg-muted motion-safe:animate-pulse" />
        <div className="h-5 w-full rounded-sm bg-muted motion-safe:animate-pulse" />
      </div>
      {Array.from({ length: fields }, (_, i) => (
        <div key={i} className="flex flex-col gap-2">
          <div className="h-5 w-24 rounded-sm bg-muted motion-safe:animate-pulse" />
          <div className="h-11 w-full rounded-md bg-muted motion-safe:animate-pulse" />
        </div>
      ))}
      <div className="h-11 w-full rounded-md bg-muted motion-safe:animate-pulse" />
    </section>
  );
}
