<script lang="ts">
  import { Checkbox as CheckboxPrimitive } from "bits-ui";
  import { Check, Minus } from "lucide-svelte";
  import { cn } from "$lib/utils.js";
  import type { CheckboxRootProps } from "bits-ui";

  interface Props extends CheckboxRootProps {
    class?: string;
  }

  let { class: className, ...restProps }: Props = $props();
</script>

<CheckboxPrimitive.Root
  class={cn(
    "peer h-3.5 w-3.5 shrink-0 rounded-[3px] border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--bg-primary)] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-secondary)] disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-[var(--accent)] data-[state=checked]:bg-[var(--accent)] data-[state=indeterminate]:border-[var(--accent)] data-[state=indeterminate]:bg-[var(--accent)]",
    className
  )}
  {...restProps}
>
  {#snippet children({ checked, indeterminate })}
    {#if checked}
      <Check class="h-3 w-3" />
    {:else if indeterminate}
      <Minus class="h-3 w-3" />
    {/if}
  {/snippet}
</CheckboxPrimitive.Root>
