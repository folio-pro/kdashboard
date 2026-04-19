<script lang="ts">
  import type { ToolGroupProps } from "./types";
  import { detectAndFormat } from "./parse-value";
  import { toggleSetItem } from "$lib/utils/k8s-helpers";

  let { annotations, toolConfig, shortKeys }: ToolGroupProps = $props();

  let expanded = $state<Set<string>>(new Set());

  let parsedValues = $derived<Record<string, ReturnType<typeof detectAndFormat>>>(
    Object.fromEntries(
      Object.entries(annotations).map(([k, v]) => [k, detectAndFormat(v)])
    )
  );

</script>

{#each Object.entries(annotations) as [key, value]}
  {@const parsed = parsedValues[key]}
  {@const short = shortKeys[key] ?? key}
  {@const isExpanded = expanded.has(key)}
  <div class="flex flex-col gap-0.5 border-t border-[var(--border-hover)] px-5 py-3.5">
    <span class="font-mono text-[11px] text-[var(--text-dimmed)]">{short}</span>
    {#if parsed.type === "json" || parsed.type === "yaml"}
      <button
        class="text-left font-mono text-[11px] text-[var(--accent)] {isExpanded ? '' : 'hover:underline'}"
        onclick={() => expanded = toggleSetItem(expanded, key)}
      >
        {#if isExpanded}
          <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-[var(--border-hover)] bg-[var(--bg-primary)] px-3 py-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">{parsed.formatted}</pre>
        {:else}
          <span class="truncate block">{value}</span>
        {/if}
      </button>
    {:else}
      <span class="truncate font-mono text-[11px] text-[var(--text-primary)]">{value}</span>
    {/if}
  </div>
{/each}
