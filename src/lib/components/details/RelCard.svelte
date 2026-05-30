<script lang="ts">
  import { ChevronRight } from "lucide-svelte";
  import type { IconComponent } from "$lib/actions/types";

  interface Props {
    icon: IconComponent;
    kind: string;
    name: string;
    sub?: string;
    onclick?: () => void;
  }

  let { icon: Icon, kind, name, sub, onclick }: Props = $props();
</script>

<button
  type="button"
  class="group flex w-full min-w-0 items-center gap-3 rounded-[7px] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-3 text-left transition-colors hover:border-[var(--border-hover)] hover:bg-[var(--bg-tertiary)]"
  {onclick}
>
  <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-tertiary)] text-[var(--accent)]">
    <Icon class="h-[17px] w-[17px]" />
  </span>
  <div class="min-w-0 flex-1">
    <div class="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]">{kind}</div>
    <div class="truncate text-[13px] font-medium text-[var(--text-primary)]">{name}</div>
    {#if sub}
      <div class="truncate text-[11px] text-[var(--text-muted)]">{sub}</div>
    {/if}
  </div>
  <ChevronRight class="h-3.5 w-3.5 shrink-0 text-[var(--text-dimmed)] transition-[transform,color] group-hover:translate-x-0.5 group-hover:text-[var(--accent)]" />
</button>
