<script lang="ts">
  import { cn } from "$lib/utils.js";
  import { tv, type VariantProps } from "tailwind-variants";
  import type { HTMLSelectAttributes } from "svelte/elements";
  import type { Snippet } from "svelte";

  /**
   * A native `<select>` on the Input scale — for a three-option picker where
   * SelectMenu's popover is overkill. Options are the children.
   */
  const selectVariants = tv({
    base: "rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50",
    variants: {
      size: {
        xs: "h-6 px-1.5 text-[11px]",
        sm: "h-7 px-2 text-[12px]",
        md: "h-8 px-2.5 text-[12px]",
      },
      mono: { true: "font-mono", false: "" },
    },
    defaultVariants: { size: "sm", mono: false },
  });

  interface Props extends Omit<HTMLSelectAttributes, "size" | "value"> {
    size?: VariantProps<typeof selectVariants>["size"];
    mono?: boolean;
    class?: string;
    value?: string;
    children: Snippet;
  }

  let { size = "sm", mono = false, class: className, value = $bindable(), children, ...rest }: Props = $props();
</script>

<select class={cn(selectVariants({ size, mono }), className)} bind:value {...rest}>
  {@render children()}
</select>
