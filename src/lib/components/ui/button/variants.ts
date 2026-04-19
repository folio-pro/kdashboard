import { tv, type VariantProps } from "tailwind-variants";

export const buttonVariants = tv({
  base: "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)] disabled:pointer-events-none disabled:opacity-50",
  variants: {
    variant: {
      default: "bg-[var(--accent)]/85 text-white hover:bg-[var(--accent)]",
      destructive: "border border-[var(--status-failed)]/50 bg-transparent text-[var(--status-failed)] hover:bg-[var(--status-failed)]/10",
      outline: "border border-[var(--border-color)] bg-transparent hover:bg-[var(--bg-secondary)] text-[var(--text-primary)]",
      secondary: "bg-[var(--bg-secondary)] text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]/80",
      ghost: "hover:bg-[var(--bg-secondary)] text-[var(--text-primary)]",
      link: "text-[var(--accent)] underline-offset-4 hover:underline",
    },
    size: {
      default: "h-9 px-4 py-2",
      sm: "h-8 rounded-md px-3 text-xs",
      lg: "h-10 rounded-md px-8",
      icon: "h-9 w-9",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "default",
  },
});

export type ButtonVariant = VariantProps<typeof buttonVariants>["variant"];
export type ButtonSize = VariantProps<typeof buttonVariants>["size"];
