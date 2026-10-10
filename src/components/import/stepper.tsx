import { Check } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

export const steps = ["choose", "match", "check", "import"] as const;
export type StepId = (typeof steps)[number];

// The four steps of an import. The current one is marked for screen readers (aria-current) and in words on phones
// ("Step 2 of 4"); done steps carry a check mark as well as a tone.
export function Stepper({ current }: { current: StepId }) {
  const t = useTranslations("Import.steps");
  const index = steps.indexOf(current);
  return (
    <div className="flex flex-col gap-2">
      <p className="font-mono text-xs text-muted-foreground sm:hidden">{t("counter", { step: index + 1, total: steps.length })}</p>
      <ol className="flex items-center gap-2 overflow-hidden sm:gap-3">
        {steps.map((step, i) => (
          <li
            key={step}
            aria-current={i === index ? "step" : undefined}
            className={cn(
              "flex min-w-0 items-center gap-2 text-sm",
              i === index ? "font-bold text-foreground" : "text-muted-foreground",
              i !== index && "max-sm:hidden",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "grid size-6 shrink-0 place-items-center rounded-full font-mono text-xs",
                i < index ? "bg-foreground text-background" : i === index ? "bg-foreground text-background" : "bg-muted",
              )}
            >
              {i < index ? <Check strokeWidth={2.5} className="size-3.5" /> : i + 1}
            </span>
            <span className="truncate">{t(step)}</span>
            {i < steps.length - 1 ? <span aria-hidden="true" className="hidden h-px w-6 bg-border sm:block" /> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
