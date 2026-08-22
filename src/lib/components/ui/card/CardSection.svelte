<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { cn } from "$lib/utils.js";
  import Card from "./Card.svelte";
  import type { IconComponent } from "$lib/actions/types";

  /**
   * A Card with a 36px header row — icon, title, subtitle, trailing actions —
   * and an unpadded body. The Overview's four panels, the topology policy
   * aside and the saved-forwards table all draw this same chrome.
   */
  interface Props extends HTMLAttributes<HTMLDivElement> {
    title: string;
    icon?: IconComponent;
    subtitle?: string;
    actions?: Snippet;
    children: Snippet;
    class?: string;
  }

  let { title, icon: Icon, subtitle, actions, children, class: className, ...rest }: Props = $props();
</script>

<Card padding="none" class={cn("flex flex-col overflow-hidden", className)} {...rest}>
  <header class="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border-color)] px-3">
    {#if Icon}<Icon class="h-3.5 w-3.5 text-[var(--text-muted)]" />{/if}
    <span class="text-[12px] font-semibold text-[var(--text-primary)]">{title}</span>
    {#if subtitle}<span class="truncate text-[11px] text-[var(--text-muted)]">{subtitle}</span>{/if}
    {#if actions}
      <div class="ml-auto flex items-center gap-2">{@render actions()}</div>
    {/if}
  </header>
  {@render children()}
</Card>
