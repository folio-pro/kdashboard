<script lang="ts">
  import { cn } from "$lib/utils.js";
  import { Search, X } from "lucide-svelte";
  import { Button } from "../button/index.js";
  import type { Snippet } from "svelte";

  /**
   * Icon + input + optional trailing affordance, in one bordered box.
   *
   * Six of these existed — the table toolbar, the sidebar filter, the log
   * filter, the configmap key filter, the namespace picker, the resource
   * search — each rebuilding the same wrapper with its own height, radius and
   * focus treatment. The wrapper is what carries the focus ring here
   * (`focus-ring-host`, see app.css): the affordance a user sees is the box,
   * so the bare input inside must not draw a second ring inside it.
   */
  interface Props {
    value: string;
    placeholder?: string;
    /** Required: the visible label is an icon, so the input needs its own. */
    ariaLabel: string;
    id?: string;
    size?: "sm" | "md";
    /** Render the value in the mono face (log and key filters). */
    mono?: boolean;
    /** Show the clear button once there is something to clear. */
    clearable?: boolean;
    oninput?: (event: Event) => void;
    onkeydown?: (event: KeyboardEvent) => void;
    onclear?: () => void;
    /** Anything that sits between the icon and the input (filter chips). */
    leading?: Snippet;
    /** Anything that sits between the input and the clear button. */
    trailing?: Snippet;
    /** The input element, for callers that focus it from a shortcut. */
    ref?: HTMLInputElement;
    class?: string;
  }

  let {
    value = $bindable(),
    placeholder = "Search…",
    ariaLabel,
    id,
    size = "md",
    mono = false,
    clearable = false,
    oninput,
    onkeydown,
    onclear,
    leading,
    trailing,
    ref = $bindable(),
    class: className,
  }: Props = $props();

  const box = {
    sm: "h-7 gap-1.5 px-2 text-[11px]",
    md: "h-8 gap-2 px-2.5 text-[12px]",
  } as const;

  const icon = {
    sm: "h-3 w-3",
    md: "h-3.5 w-3.5",
  } as const;
</script>

<div
  class={cn(
    "focus-ring-host flex items-center rounded-md border border-[var(--border-hover)] bg-[var(--bg-tertiary)] transition-[border-color,box-shadow] focus-within:border-[var(--accent)] focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_18%,transparent)]",
    box[size],
    className
  )}
>
  <Search class={cn("shrink-0 text-[var(--text-muted)]", icon[size])} />
  {@render leading?.()}
  <input
    bind:this={ref}
    bind:value
    {id}
    type="text"
    {placeholder}
    aria-label={ariaLabel}
    {oninput}
    {onkeydown}
    class={cn(
      "h-full min-w-0 flex-1 bg-transparent text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none",
      mono && "font-mono"
    )}
  />
  {@render trailing?.()}
  {#if clearable && value}
    <Button
      variant="muted"
      size="icon-xs"
      class="shrink-0"
      onclick={() => {
        value = "";
        onclear?.();
      }}
      aria-label="Clear {ariaLabel.toLowerCase()}"
    >
      <X class={icon[size]} />
    </Button>
  {/if}
</div>
