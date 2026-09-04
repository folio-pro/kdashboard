<script lang="ts">
  import { cn } from "$lib/utils.js";
  import { tv, type VariantProps } from "tailwind-variants";
  import type { HTMLInputAttributes } from "svelte/elements";

  /**
   * Text input. Heights mirror the Button scale (xs 6 / sm 7 / md 8 / lg 9)
   * so a control and its adjacent button line up without either side passing
   * a one-off `class="h-7"` — which is exactly what every call site used to do.
   */
  const inputVariants = tv({
    base: "flex w-full rounded-md border border-[var(--border-color)] bg-transparent text-[var(--text-primary)] transition-colors placeholder:text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50",
    variants: {
      size: {
        xs: "h-6 px-2 text-[11px]",
        sm: "h-7 px-2.5 text-[12px]",
        md: "h-8 px-3 text-[12px]",
        lg: "h-9 px-3 text-[13px]",
      },
      mono: {
        true: "font-mono",
        false: "",
      },
    },
    defaultVariants: {
      size: "md",
      mono: false,
    },
  });

  type InputSize = VariantProps<typeof inputVariants>["size"];

  interface Props extends Omit<HTMLInputAttributes, "size"> {
    size?: InputSize;
    mono?: boolean;
    class?: string;
  }

  // `value` is bindable so callers can `bind:value` (filter boxes, pickers)
  // instead of wiring oninput by hand.
  let { size = "md", mono = false, class: className, value = $bindable(), ...restProps }: Props = $props();
</script>

<input class={cn(inputVariants({ size, mono }), className)} bind:value {...restProps} />
