<script lang="ts">
  import { Badge } from "$lib/components/ui";
  import type { ToolGroupProps } from "./types";
  import { detectAndFormat } from "./parse-value";
  import { toggleSetItem } from "$lib/utils/k8s-helpers";
  import AnnotationValue from "../AnnotationValue.svelte";

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
    <span class="font-mono text-[11px] text-[var(--text-muted)]">Sidecar Injection</span>
    <Badge tone={injectValue === "true" ? "success" : "error"} class="px-2">
      {injectValue === "true" ? "Enabled" : "Disabled"}
    </Badge>
  </div>
{/if}

<!-- Revision tag -->
{#if revValue !== null}
  <div class="flex items-center gap-3 border-t border-[var(--border-hover)] px-5 py-3.5">
    <span class="font-mono text-[11px] text-[var(--text-muted)]">Revision</span>
    <Badge appearance="surface" class="px-2">
      {revValue}
    </Badge>
  </div>
{/if}

<!-- Proxy resources -->
{#if proxyMemory !== null || proxyCPU !== null}
  <div class="flex items-center gap-4 border-t border-[var(--border-hover)] px-5 py-3.5">
    <span class="font-mono text-[11px] text-[var(--text-muted)]">Proxy Resources</span>
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
    <span class="font-mono text-[11px] text-[var(--text-muted)]">{short}</span>
    {#if parsed.type === "json" || parsed.type === "yaml"}
      <AnnotationValue
        {value}
        formatted={parsed.formatted}
        expanded={isExpanded}
        ontoggle={() => (expanded = toggleSetItem(expanded, key))}
      />
    {:else}
      <span class="truncate font-mono text-[11px] text-[var(--text-primary)]">{value}</span>
    {/if}
  </div>
{/each}
