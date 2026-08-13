<script lang="ts">
  import { cn } from "$lib/utils.js";
  import { toneStyle } from "../tones.js";
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
    style,
    children,
    ...restProps
  }: Props = $props();

  // `tone` is a value, not an appearance, so it travels as an inline custom
  // property rather than a class. Several call sites pass a colour the tone
  // vocabulary has no name for (`--log-json`, a probe type) straight through
  // `style`; theirs comes last, so it still wins.
  const inlineStyle = $derived(style ? `${toneStyle(tone)} ${style}` : toneStyle(tone));
</script>

<span
  class={cn(badgeVariants({ appearance, size, pill, bordered, mono }), className)}
  {...restProps}
  style={inlineStyle}
>
  {@render children?.()}
</span>
