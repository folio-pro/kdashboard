<script lang="ts">
  import { cn } from "$lib/utils.js";
  import {
    badgeVariants,
    type BadgeTone,
    type BadgeAppearance,
    type BadgeSize,
  } from "./variants.js";
  import type { HTMLAttributes } from "svelte/elements";

  interface Props extends HTMLAttributes<HTMLSpanElement> {
    tone?: BadgeTone;
    appearance?: BadgeAppearance;
    size?: BadgeSize;
    pill?: boolean;
    bordered?: boolean;
    mono?: boolean;
    class?: string;
  }

  let {
    tone = "neutral",
    appearance = "soft",
    size = "xs",
    pill = false,
    bordered = false,
    mono = false,
    class: className,
    children,
    ...restProps
  }: Props = $props();
</script>

<span class={cn(badgeVariants({ tone, appearance, size, pill, bordered, mono }), className)} {...restProps}>
  {@render children?.()}
</span>
