<script lang="ts">
  interface Props {
    title?: string;
    labels: Record<string, string>;
  }

  let { title = "Labels", labels }: Props = $props();
</script>

{#if Object.keys(labels).length > 0}
  <div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
    <div class="flex items-center justify-between px-5 py-4">
      <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">{title}</h3>
      <span class="text-xs text-[var(--text-muted)]">{Object.keys(labels).length}</span>
    </div>
    {#each Object.entries(labels) as [key, value]}
      <div class="flex items-center border-t border-[var(--border-hover)] px-5 py-3.5">
        <span class="truncate font-mono text-[11px] text-[var(--text-muted)]">{key}=<span class="text-[var(--text-primary)]">{value}</span></span>
      </div>
    {/each}
  </div>
{/if}
