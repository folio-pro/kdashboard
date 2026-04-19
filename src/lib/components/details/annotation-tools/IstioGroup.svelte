<script lang="ts">
  import type { ToolGroupProps } from "./types";
  import { detectAndFormat } from "./parse-value";
  import { toggleSetItem } from "$lib/utils/k8s-helpers";

  let { annotations, toolConfig, shortKeys }: ToolGroupProps = $props();

  let expanded = $state<Set<string>>(new Set());

  let injectValue = $derived(
    annotations["sidecar.istio.io/inject"] ?? null
  );
  let revValue = $derived(
    annotations["istio.io/rev"] ?? null
  );
  let proxyMemory = $derived(
    annotations["sidecar.istio.io/proxyMemory"] ?? null
  );
  let proxyCPU = $derived(
    annotations["sidecar.istio.io/proxyCPU"] ?? null
  );

  const SPECIAL_KEYS = new Set([
    "sidecar.istio.io/inject",
    "istio.io/rev",
    "sidecar.istio.io/proxyMemory",
    "sidecar.istio.io/proxyCPU",
  ]);

  let otherAnnotations = $derived(
    Object.fromEntries(
      Object.entries(annotations).filter(([k]) => !SPECIAL_KEYS.has(k))
    )
  );

  let parsedValues = $derived<Record<string, ReturnType<typeof detectAndFormat>>>(
    Object.fromEntries(
      Object.entries(otherAnnotations).map(([k, v]) => [k, detectAndFormat(v)])
    )
  );

</script>

<!-- Sidecar injection badge -->
{#if injectValue !== null}
  <div class="flex items-center gap-3 border-t border-[var(--border-hover)] px-5 py-3.5">
    <span class="font-mono text-[11px] text-[var(--text-dimmed)]">Sidecar Injection</span>
    <span class="inline-flex items-center rounded px-2 py-0.5 text-[10px] font-medium {injectValue === 'true' ? 'bg-[var(--status-running)]/15 text-[var(--status-running)]' : 'bg-[var(--status-failed)]/15 text-[var(--status-failed)]'}">
      {injectValue === "true" ? "Enabled" : "Disabled"}
    </span>
  </div>
{/if}

<!-- Revision tag -->
{#if revValue !== null}
  <div class="flex items-center gap-3 border-t border-[var(--border-hover)] px-5 py-3.5">
    <span class="font-mono text-[11px] text-[var(--text-dimmed)]">Revision</span>
    <span class="inline-flex items-center rounded bg-[var(--bg-tertiary)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-secondary)]">
      {revValue}
    </span>
  </div>
{/if}

<!-- Proxy resources -->
{#if proxyMemory !== null || proxyCPU !== null}
  <div class="flex items-center gap-4 border-t border-[var(--border-hover)] px-5 py-3.5">
    <span class="font-mono text-[11px] text-[var(--text-dimmed)]">Proxy Resources</span>
    <div class="flex items-center gap-3">
      {#if proxyCPU !== null}
        <span class="font-mono text-[11px] text-[var(--text-primary)]">CPU: {proxyCPU}</span>
      {/if}
      {#if proxyMemory !== null}
        <span class="font-mono text-[11px] text-[var(--text-primary)]">Memory: {proxyMemory}</span>
      {/if}
    </div>
  </div>
{/if}

<!-- Other Istio annotations (generic display) -->
{#each Object.entries(otherAnnotations) as [key, value]}
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
