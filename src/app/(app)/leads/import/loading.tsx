// Matches the import page: title, the step card (stepper, heading, drop zone) and the past-imports rail.
export default function Loading() {
  return (
    <div aria-hidden="true" className="flex flex-1 flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="h-9 w-56 rounded-md bg-muted motion-safe:animate-pulse" />
        <div className="h-5 w-full max-w-[520px] rounded-md bg-muted motion-safe:animate-pulse" />
      </div>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        <div className="flex flex-col gap-6 rounded-lg bg-card p-4 sm:p-8">
          <div className="h-6 w-full max-w-[420px] rounded-md bg-muted motion-safe:animate-pulse" />
          <div className="h-7 w-48 rounded-md bg-muted motion-safe:animate-pulse" />
          <div className="h-[236px] rounded-lg bg-muted motion-safe:animate-pulse" />
        </div>
        <div className="flex flex-col gap-4 rounded-lg bg-card p-4 sm:p-6">
          <div className="h-6 w-32 rounded-md bg-muted motion-safe:animate-pulse" />
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-24 rounded-md bg-muted motion-safe:animate-pulse" />
          ))}
        </div>
      </div>
    </div>
  );
}
