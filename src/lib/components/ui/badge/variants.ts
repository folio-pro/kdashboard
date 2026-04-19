import { tv, type VariantProps } from "tailwind-variants";

export const badgeVariants = tv({
  base: "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:ring-offset-2",
  variants: {
    variant: {
      default: "border-transparent bg-[var(--accent)] text-white",
      secondary: "border-transparent bg-[var(--bg-secondary)] text-[var(--text-primary)]",
      destructive: "border-transparent bg-[var(--status-failed)] text-white",
      outline: "border-[var(--border-color)] text-[var(--text-primary)]",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export type BadgeVariant = VariantProps<typeof badgeVariants>["variant"];
