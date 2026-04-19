<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    label: string;
    value?: string;
    valueColor?: string;
    children?: Snippet;
  }

  let { label, value, valueColor, children }: Props = $props();
</script>

<div class="flex h-11 items-center border-t border-[var(--border-hover)] px-5">
  <div class="w-[140px] shrink-0 text-xs font-medium text-[var(--text-dimmed)]">{label}</div>
  {#if children}
    <div class="min-w-0 flex-1">
      {@render children()}
    </div>
  {:else}
    <div class="min-w-0 flex-1 truncate text-[13px] font-medium" style:color={valueColor ?? 'var(--text-primary)'}>
      {value}
    </div>
  {/if}
</div>
