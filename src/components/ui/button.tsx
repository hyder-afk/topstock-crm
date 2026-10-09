import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// shadcn-style button on TopStock tokens. "brand" is the one primary action per screen (black text on Signal Red).
const buttonVariants = cva(
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-4 text-base font-bold transition-[filter,transform,background-color,color] duration-150 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-60",
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

export function Button({
  className,
  variant,
  width,
  type = "button",
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return <button type={type} className={cn(buttonVariants({ variant, width }), className)} {...props} />;
}

export { buttonVariants };
