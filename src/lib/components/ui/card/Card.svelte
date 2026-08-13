<script lang="ts">
  import { cn } from "$lib/utils.js";
  import { tv, type VariantProps } from "tailwind-variants";
  import type { HTMLAttributes } from "svelte/elements";

  /**
   * The bordered surface used by detail cards, empty states, toasts and
   * settings sections. Roughly a dozen copies of
   * `rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3`
   * existed; `tone` also replaces the four SecurityView severity cards that
   * bordered on raw Tailwind palette colours.
   */
  const cardVariants = tv({
    base: "rounded-lg border",
    variants: {
      tone: {
        neutral: "border-[var(--border-color)]",
        accent: "border-[var(--accent)]/30",
        success: "border-[var(--status-running)]/30",
        warning: "border-[var(--status-pending)]/30",
        error: "border-[var(--status-failed)]/30",
        info: "border-[var(--status-succeeded)]/30",
        terminating: "border-[var(--status-terminating)]/30",
        muted: "border-[var(--text-muted)]/30",
      },
      surface: {
        secondary: "bg-[var(--bg-secondary)]",
        tertiary: "bg-[var(--bg-tertiary)]",
        none: "bg-transparent",
      },
      padding: {
        none: "",
        sm: "p-3",
        md: "p-4",
      },
    },
    defaultVariants: {
      tone: "neutral",
      surface: "secondary",
      padding: "sm",
    },
  });

  type Variants = VariantProps<typeof cardVariants>;

  interface Props extends HTMLAttributes<HTMLDivElement> {
    tone?: Variants["tone"];
    surface?: Variants["surface"];
    padding?: Variants["padding"];
    class?: string;
  }

  let {
    tone = "neutral",
    surface = "secondary",
    padding = "sm",
    class: className,
    children,
    ...restProps
  }: Props = $props();
</script>

<div class={cn(cardVariants({ tone, surface, padding }), className)} {...restProps}>
  {@render children?.()}
</div>
