<script lang="ts">
  import { Badge } from "$lib/components/ui";
  import type { ToolGroupProps } from "./types";
  import { detectAndFormat } from "./parse-value";
  import { parse as parseYaml } from "yaml";
  import { toggleSetItem } from "$lib/utils/k8s-helpers";
  import AnnotationValue from "../AnnotationValue.svelte";

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
      <Badge appearance="surface" class="px-2">
        {parsedConfig.kind ?? "Mapping"}
      </Badge>
      {#if parsedConfig.apiVersion}
        <span class="text-[10px] text-[var(--text-muted)]">{parsedConfig.apiVersion}</span>
      {/if}
    </div>
    <div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
      {#if parsedConfig.prefix || parsedConfig.prefix_regex}
        <span class="font-mono text-[11px] text-[var(--text-muted)]">Route</span>
        <span class="font-mono text-[11px] text-[var(--text-primary)]">{parsedConfig.prefix ?? parsedConfig.prefix_regex}</span>
      {/if}
      {#if parsedConfig.service}
        <span class="font-mono text-[11px] text-[var(--text-muted)]">Service</span>
        <span class="font-mono text-[11px] text-[var(--accent)]">{parsedConfig.service}</span>
      {/if}
      {#if parsedConfig.timeout_ms}
        <span class="font-mono text-[11px] text-[var(--text-muted)]">Timeout</span>
        <span class="font-mono text-[11px] text-[var(--text-primary)]">{Math.round(Number(parsedConfig.timeout_ms) / 1000)}s</span>
      {/if}
      {#if parsedConfig.host}
        <span class="font-mono text-[11px] text-[var(--text-muted)]">Host</span>
        <span class="font-mono text-[11px] text-[var(--text-primary)]">{parsedConfig.host}</span>
      {/if}
      {#if parsedConfig.rewrite}
        <span class="font-mono text-[11px] text-[var(--text-muted)]">Rewrite</span>
        <span class="font-mono text-[11px] text-[var(--text-primary)]">{parsedConfig.rewrite}</span>
      {/if}
    </div>
  </div>
{:else if configAnnotation}
  <!-- Config exists but couldn't be parsed → show raw -->
  <div class="flex flex-col gap-0.5 border-t border-[var(--border-hover)] px-5 py-3.5">
    <span class="font-mono text-[11px] text-[var(--text-muted)]">config</span>
    <AnnotationValue
      value={configAnnotation}
      expanded={expanded.has("config")}
      ontoggle={() => (expanded = toggleSetItem(expanded, "config"))}
    />
  </div>
{/if}

<!-- Other Ambassador annotations as pills/values -->
{#each Object.entries(otherAnnotations) as [key, value]}
  {@const parsed = parsedValues[key]}
  {@const short = shortKeys[key] ?? key}
  {@const isExpanded = expanded.has(key)}
  <div class="flex flex-col gap-0.5 border-t border-[var(--border-hover)] px-5 py-3.5">
    <span class="font-mono text-[11px] text-[var(--text-muted)]">{short}</span>
    {#if value === "true" || value === "false"}
      <Badge tone={value === "true" ? "success" : "error"} class="w-fit px-2">
        {value}
      </Badge>
    {:else if parsed.type === "json" || parsed.type === "yaml"}
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
