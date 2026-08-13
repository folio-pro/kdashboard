<script lang="ts">
  import { cn } from "$lib/utils.js";
  import { toneStyle } from "../tones.js";
  import {
    buttonVariants,
    type ButtonVariant,
    type ButtonSize,
    type ButtonTone,
    type ButtonActiveStyle,
  } from "./variants.js";
  import type { HTMLButtonAttributes } from "svelte/elements";

  interface Props extends HTMLButtonAttributes {
    variant?: ButtonVariant;
    size?: ButtonSize;
    /** Render the label in the mono face (toolbars, log controls). */
    mono?: boolean;
    /** Colour of the selected state, and of `toolbar-tone` at rest. */
    tone?: ButtonTone;
    /**
     * Selected state for segmented/filter controls. Left undefined the button
     * is not a toggle and carries no aria-pressed; set to false it is a toggle
     * that happens to be off, which assistive technology has to be told.
     */
    active?: boolean;
    activeStyle?: ButtonActiveStyle;
    class?: string;
  }

  let {
    variant = "accent",
    size = "md",
    mono = false,
    tone = "accent",
    active,
    activeStyle = "solid",
    class: className,
    style,
    children,
    ...restProps
  }: Props = $props();

  // `tone` is a value, not an appearance, so it travels as an inline custom
  // property rather than a class. The call site's own declarations come last,
  // so a one-off `style` still wins.
  const inlineStyle = $derived(style ? `${toneStyle(tone)} ${style}` : toneStyle(tone));
</script>

<!-- restProps is spread first so a call site cannot contradict the ARIA state
     the component derives from `active`, and `type` defaults to "button": the
     HTML default is "submit", which makes any control inside a form submit it. -->
<button
  type="button"
  {...restProps}
  class={cn(buttonVariants({ variant, size, mono, active: active ?? false, activeStyle }), className)}
  style={inlineStyle}
  aria-pressed={active}
>
  {@render children?.()}
</button>
