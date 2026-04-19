<script lang="ts">
  import type { ToolGroupProps } from "./types";
  import { detectAndFormat } from "./parse-value";
  import { parse as parseYaml } from "yaml";
  import { toggleSetItem } from "$lib/utils/k8s-helpers";

  let { annotations, toolConfig, shortKeys }: ToolGroupProps = $props();

  let expanded = $state<Set<string>>(new Set());

  let configAnnotation = $derived(
    annotations["getambassador.io/config"] ?? null
  );

  let parsedConfig = $derived.by(() => {
    if (!configAnnotation) return null;
    try {
      const doc = parseYaml(configAnnotation);
      if (doc && typeof doc === "object") return doc as Record<string, unknown>;
    } catch { /* fallback to generic display */ }
    return null;
  });

  let otherAnnotations = $derived(
    Object.fromEntries(
      Object.entries(annotations).filter(([k]) => k !== "getambassador.io/config")
    )
  );

  let parsedValues = $derived<Record<string, ReturnType<typeof detectAndFormat>>>(
    Object.fromEntries(
      Object.entries(otherAnnotations).map(([k, v]) => [k, detectAndFormat(v)])
    )
  );

</script>

<!-- Structured Ambassador config display -->
{#if parsedConfig}
  <div class="border-t border-[var(--border-hover)] px-5 py-3.5">
    <div class="flex items-center gap-2 mb-2">
      <span class="inline-flex items-center rounded bg-[var(--bg-tertiary)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-secondary)]">
        {parsedConfig.kind ?? "Mapping"}
      </span>
      {#if parsedConfig.apiVersion}
        <span class="text-[10px] text-[var(--text-dimmed)]">{parsedConfig.apiVersion}</span>
      {/if}
    </div>
    <div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
      {#if parsedConfig.prefix || parsedConfig.prefix_regex}
        <span class="font-mono text-[11px] text-[var(--text-dimmed)]">Route</span>
        <span class="font-mono text-[11px] text-[var(--text-primary)]">{parsedConfig.prefix ?? parsedConfig.prefix_regex}</span>
      {/if}
      {#if parsedConfig.service}
        <span class="font-mono text-[11px] text-[var(--text-dimmed)]">Service</span>
        <span class="font-mono text-[11px] text-[var(--accent)]">{parsedConfig.service}</span>
      {/if}
      {#if parsedConfig.timeout_ms}
        <span class="font-mono text-[11px] text-[var(--text-dimmed)]">Timeout</span>
        <span class="font-mono text-[11px] text-[var(--text-primary)]">{Math.round(Number(parsedConfig.timeout_ms) / 1000)}s</span>
      {/if}
      {#if parsedConfig.host}
        <span class="font-mono text-[11px] text-[var(--text-dimmed)]">Host</span>
        <span class="font-mono text-[11px] text-[var(--text-primary)]">{parsedConfig.host}</span>
      {/if}
      {#if parsedConfig.rewrite}
        <span class="font-mono text-[11px] text-[var(--text-dimmed)]">Rewrite</span>
        <span class="font-mono text-[11px] text-[var(--text-primary)]">{parsedConfig.rewrite}</span>
      {/if}
    </div>
  </div>
{:else if configAnnotation}
  <!-- Config exists but couldn't be parsed → show raw -->
  <div class="flex flex-col gap-0.5 border-t border-[var(--border-hover)] px-5 py-3.5">
    <span class="font-mono text-[11px] text-[var(--text-dimmed)]">config</span>
    <button
      class="text-left font-mono text-[11px] text-[var(--accent)] {expanded.has('config') ? '' : 'hover:underline'}"
      onclick={() => expanded = toggleSetItem(expanded, "config")}
    >
      {#if expanded.has("config")}
        <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-[var(--border-hover)] bg-[var(--bg-primary)] px-3 py-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">{configAnnotation}</pre>
      {:else}
        <span class="truncate block">{configAnnotation}</span>
      {/if}
    </button>
  </div>
{/if}

<!-- Other Ambassador annotations as pills/values -->
{#each Object.entries(otherAnnotations) as [key, value]}
  {@const parsed = parsedValues[key]}
  {@const short = shortKeys[key] ?? key}
  {@const isExpanded = expanded.has(key)}
  <div class="flex flex-col gap-0.5 border-t border-[var(--border-hover)] px-5 py-3.5">
    <span class="font-mono text-[11px] text-[var(--text-dimmed)]">{short}</span>
    {#if value === "true" || value === "false"}
      <span class="inline-flex w-fit items-center rounded px-2 py-0.5 text-[10px] font-medium {value === 'true' ? 'bg-[var(--status-running)]/15 text-[var(--status-running)]' : 'bg-[var(--status-failed)]/15 text-[var(--status-failed)]'}">
        {value}
      </span>
    {:else if parsed.type === "json" || parsed.type === "yaml"}
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
