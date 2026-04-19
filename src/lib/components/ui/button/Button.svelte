<script lang="ts">
  import { cn } from "$lib/utils.js";
  import { buttonVariants, type ButtonVariant, type ButtonSize } from "./variants.js";
  import type { HTMLButtonAttributes } from "svelte/elements";

  interface Props extends HTMLButtonAttributes {
    variant?: ButtonVariant;
    size?: ButtonSize;
    class?: string;
  }

  let { variant = "default", size = "default", class: className, children, ...restProps }: Props = $props();
</script>

<button class={cn(buttonVariants({ variant, size }), className)} {...restProps}>
  {@render children?.()}
</button>
