<script lang="ts">
  import { cn } from "$lib/utils.js";
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
    /** Selected state for segmented/filter controls. */
    active?: boolean;
    activeStyle?: ButtonActiveStyle;
    class?: string;
  }

  let {
    variant = "accent",
    size = "md",
    mono = false,
    tone = "accent",
    active = false,
    activeStyle = "solid",
    class: className,
    children,
    ...restProps
  }: Props = $props();
</script>

<button
  class={cn(buttonVariants({ variant, size, mono, tone, active, activeStyle }), className)}
  aria-pressed={active ? true : undefined}
  {...restProps}
>
  {@render children?.()}
</button>
