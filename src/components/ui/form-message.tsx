import { cn } from "@/lib/utils";

// One live region per form: errors are announced, and carry a word as well as colour.
// No native popups (Haider 15 Oct 2026): every <form> sets noValidate, so the browser never shows its own validation
// bubble; required, min, max and patterns are checked by our Zod schemas and reported here (and with aria-invalid on
// the field). The app's pickers never put `required` on a native element, so they cannot raise a bubble either.
export function FormMessage({ id, tone, children }: { id?: string; tone: "error" | "info"; children?: React.ReactNode }) {
  return (
    <p
      id={id}
      role={tone === "error" ? "alert" : "status"}
      className={cn("min-h-6 text-sm", tone === "error" ? "text-status-red" : "text-muted-foreground")}
    >
      {children}
    </p>
  );
}
