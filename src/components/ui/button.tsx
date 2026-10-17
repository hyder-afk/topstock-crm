import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// shadcn-style button on TopStock tokens. "brand" is the one primary action per screen (black text on Signal Red).
const variants = cva(
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-4 text-base font-bold transition-[filter,transform,scale,background-color,color] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-60 aria-disabled:opacity-60 aria-disabled:active:scale-100",
  {
    variants: {
      variant: {
        brand: "bg-brand text-brand-foreground hover:brightness-105",
        neutral: "bg-primary text-primary-foreground hover:brightness-110",
        quiet: "bg-muted text-foreground hover:brightness-95 dark:hover:brightness-125",
        link: "min-h-11 px-0 font-normal text-muted-foreground underline-offset-4 hover:text-foreground hover:underline",
      },
      width: { auto: "", full: "w-full" },
    },
    defaultVariants: { variant: "brand", width: "auto" },
  },
);

// Merged, so a variant's own padding replaces the base padding also where the classes go on a link or a trigger
// instead of <Button> (the "link" look on a Link kept the base side padding before).
function buttonVariants(props?: VariantProps<typeof variants>) {
  return cn(variants(props));
}

export function Button({
  className,
  variant,
  width,
  type = "button",
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof variants>) {
  return <button type={type} className={cn(variants({ variant, width }), className)} {...props} />;
}

export { buttonVariants };
