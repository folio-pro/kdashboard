<script lang="ts">
  import { cn } from "$lib/utils.js";
  import { badgeVariants, type BadgeVariant } from "./variants.js";
  import type { HTMLAttributes } from "svelte/elements";

  interface Props extends HTMLAttributes<HTMLDivElement> {
    variant?: BadgeVariant;
    class?: string;
  }

  let { variant = "default", class: className, children, ...restProps }: Props = $props();
</script>

<div class={cn(badgeVariants({ variant }), className)} {...restProps}>
  {@render children?.()}
</div>
