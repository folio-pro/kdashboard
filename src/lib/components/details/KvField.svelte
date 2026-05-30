<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    label: string;
    value?: string | number | null;
    /** Render the value in monospace (default — matches the reference .kv__v). */
    mono?: boolean;
    /** Custom value content (pills, links). Overrides `value`. */
    children?: Snippet;
  }

  let { label, value, mono = true, children }: Props = $props();
</script>

<div class="flex min-w-0 flex-col gap-1">
  <span class="text-[11px] text-[var(--text-muted)]">{label}</span>
  {#if children}
    {@render children()}
  {:else}
    <span class="break-all text-[13px] text-[var(--text-primary)] {mono ? 'font-mono' : ''}">{value ?? "—"}</span>
  {/if}
</div>
