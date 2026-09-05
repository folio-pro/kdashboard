<script lang="ts" module>
  import type { IconComponent } from "$lib/actions/types";

  /**
   * A recessed strip of mutually exclusive options (Costs | Rightsizing,
   * CPU | Memory, All | Over | Under …). Six views had hand-rolled this with
   * raw buttons and colour ternaries; this is the one spelling, built on
   * `Button variant="segment"` + `activeStyle="raised"` like DensityToggle.
   */
  export interface SegmentItem<V extends string> {
    value: V;
    label: string;
    icon?: IconComponent;
    /** Optional `data-testid` for the item. */
    testid?: string;
  }
</script>

<script lang="ts" generics="T extends string">
  import { cn } from "$lib/utils.js";
  import { Button } from "../button/index.js";

  interface Props {
    items: SegmentItem<T>[];
    value: T;
    onchange: (value: T) => void;
    size?: "xs" | "sm";
    ariaLabel: string;
    class?: string;
    /** `data-testid` on the strip itself. */
    testid?: string;
  }

  let { items, value, onchange, size = "xs", ariaLabel, class: className, testid }: Props = $props();
</script>

<div
  class={cn("flex shrink-0 items-center gap-0.5 rounded-md bg-[var(--bg-tertiary)] p-0.5", className)}
  role="radiogroup"
  aria-label={ariaLabel}
  data-testid={testid}
>
  {#each items as item (item.value)}
    {@const active = item.value === value}
    <Button
      variant="segment"
      {size}
      {active}
      activeStyle="raised"
      role="radio"
      aria-checked={active}
      data-testid={item.testid}
      onclick={() => onchange(item.value)}
    >
      {#if item.icon}<item.icon class="h-3 w-3" />{/if}
      {item.label}
    </Button>
  {/each}
</div>
