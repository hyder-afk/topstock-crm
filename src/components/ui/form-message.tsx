import { cn } from "@/lib/utils";

// One live region per form: errors are announced, and carry a word as well as colour.
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
