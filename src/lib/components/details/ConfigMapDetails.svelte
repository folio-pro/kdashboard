<script lang="ts">
  import { FileText, Copy, Check, ChevronRight } from "lucide-svelte";
  import { Badge, Button } from "$lib/components/ui";
  import type { Resource } from "$lib/types";
  import { toggleSetItem } from "$lib/utils/k8s-helpers";
  import MetadataSection from "./MetadataSection.svelte";
  import LabelsSection from "./LabelsSection.svelte";
  import DetailSection from "./DetailSection.svelte";
  import KvField from "./KvField.svelte";
  import KvGrid from "./KvGrid.svelte";
  import SmartAnnotationsCard from "./SmartAnnotationsCard.svelte";
  import RelatedResourcesCard from "./RelatedResourcesCard.svelte";
  import { base64ByteLength, formatBytes, summarizeValue } from "./config-data.logic";
  import type { HydrationStatus } from "./detail-panel";

  interface Props {
    resource: Resource;
    /**
     * The list row carries key names only; values arrive with the full object
     * DetailPanel fetches. Until then keys render without values or actions.
     */
    valuesStatus?: HydrationStatus;
  }

  let { resource, valuesStatus = "ready" }: Props = $props();
  let ready = $derived(valuesStatus === "ready");

  let labels = $derived(resource.metadata.labels ?? {});
  let annotations = $derived(resource.metadata.annotations ?? {});
  let data = $derived((resource.data ?? {}) as Record<string, unknown>);
  // The list projection ships `data` key names only; `binaryData` is present
  // only when the object came through a full get.
  let binaryData = $derived(
    ((resource as unknown as { binaryData?: Record<string, string> }).binaryData ?? {}) as Record<string, string>,
  );
  let immutable = $derived((resource as unknown as { immutable?: boolean }).immutable === true);

  let entries = $derived(
    Object.entries(data)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, raw]) => {
        const value = typeof raw === "string" ? raw : JSON.stringify(raw ?? "", null, 2);
        return { key, value, ...summarizeValue(value) };
      }),
  );
  let binaryEntries = $derived(
    Object.entries(binaryData)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, b64]) => ({ key, bytes: base64ByteLength(String(b64 ?? "")) })),
  );

  // Long values start collapsed; the set holds the keys the user opened.
  // Reset per resource so the aside preview never inherits another map's state.
  let expanded = $state<Set<string>>(new Set());
  let expandedFor = "";
  $effect(() => {
    const uid = resource.metadata.uid;
    if (uid !== expandedFor) {
      expandedFor = uid;
      expanded = new Set();
    }
  });

  let copiedKey = $state<string | null>(null);

  async function copyValue(key: string, value: string) {
    await navigator.clipboard.writeText(value);
    copiedKey = key;
    setTimeout(() => { if (copiedKey === key) copiedKey = null; }, 1500);
  }

  function copyAll() {
    copyValue("__all__", entries.map((e) => `${e.key}=${e.value}`).join("\n"));
  }
</script>

<div class="select-text">
  <MetadataSection {resource} />

  <DetailSection title="ConfigMap" icon={FileText}>
    <KvGrid>
      <KvField label="Keys" value={entries.length} />
      {#if binaryEntries.length > 0}
        <KvField label="Binary keys" value={binaryEntries.length} />
      {/if}
      {#if immutable}
        <KvField label="Immutable">
          <span class="font-mono text-[13px] text-[var(--status-pending)]">Yes</span>
        </KvField>
      {/if}
    </KvGrid>
  </DetailSection>

  <div class="border-b border-[var(--border-color)]" data-testid="configmap-data">
    <div class="flex items-center justify-between px-6 py-4">
      <span class="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">Data</span>
      <div class="flex items-center gap-3">
        {#if ready && entries.length > 0}
          <Button variant="link" size="inline-xs" onclick={copyAll}>
            {copiedKey === "__all__" ? "copied!" : "copy all"}
          </Button>
        {/if}
        <span class="font-mono text-[11px] text-[var(--text-muted)]">{entries.length + binaryEntries.length}</span>
      </div>
    </div>

    {#if entries.length === 0 && binaryEntries.length === 0}
      <div class="px-6 pb-4">
        <span class="text-[12px] text-[var(--text-muted)]">This ConfigMap has no data</span>
      </div>
    {/if}

    {#each entries as entry (entry.key)}
      {@const isOpen = !entry.long || expanded.has(entry.key)}
      <div class="border-t border-[var(--border-hover)] px-6 py-3">
        <div class="mb-1 flex items-center justify-between gap-3">
          <div class="flex min-w-0 items-center gap-2">
            {#if entry.long}
              <Button
                variant="muted"
                size="icon-xs"
                onclick={() => (expanded = toggleSetItem(expanded, entry.key))}
                title={isOpen ? "Collapse" : "Expand"}
                aria-expanded={isOpen}
              >
                <ChevronRight class="h-3 w-3 transition-transform {isOpen ? 'rotate-90' : ''}" />
              </Button>
            {/if}
            <span class="min-w-0 truncate font-mono text-[12px] font-medium text-[var(--text-primary)]" title={entry.key}>{entry.key}</span>
          </div>
          <!-- Size and copy wait for the values (DetailPanel's get_resource). -->
          <div class="flex h-5 shrink-0 items-center gap-2">
            {#if !ready}
              <span class="font-mono text-[10px] text-[var(--text-muted)]">…</span>
            {:else}
              <span class="font-mono text-[10px] text-[var(--text-muted)]">
                {#if entry.block}{entry.lines} {entry.lines === 1 ? "line" : "lines"} · {/if}{formatBytes(entry.chars)}
              </span>
              <Button variant="muted" size="icon-xs" onclick={() => copyValue(entry.key, entry.value)} title="Copy value">
                {#if copiedKey === entry.key}
                  <Check class="h-3 w-3 text-[var(--status-running)]" />
                {:else}
                  <Copy class="h-3 w-3" />
                {/if}
              </Button>
            {/if}
          </div>
        </div>
        {#if valuesStatus === "loading"}
          <span class="font-mono text-[12px] text-[var(--text-muted)]">Loading…</span>
        {:else if valuesStatus === "error"}
          <span class="text-[12px] text-[var(--status-failed)]">Could not load the value — see the YAML tab.</span>
        {:else if !entry.block}
          <span class="break-all font-mono text-[12px] text-[var(--text-secondary)]">{entry.value.length === 0 ? "(empty)" : entry.value}</span>
        {:else if isOpen}
          <pre class="max-h-[480px] overflow-auto whitespace-pre rounded-sm border border-[var(--border-hover)] bg-[var(--bg-primary)] px-3 py-2 font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]">{entry.value}</pre>
        {:else}
          <button
            class="w-full rounded-sm border border-[var(--border-hover)] bg-[var(--bg-primary)] px-3 py-2 text-left font-mono text-[11px] leading-relaxed text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
            onclick={() => (expanded = toggleSetItem(expanded, entry.key))}
          >{entry.value.split("\n").slice(0, 3).join("\n")}
…  show all {entry.lines} lines</button>
        {/if}
      </div>
    {/each}

    {#each binaryEntries as entry (entry.key)}
      <div class="flex items-center justify-between gap-3 border-t border-[var(--border-hover)] px-6 py-3">
        <span class="min-w-0 truncate font-mono text-[12px] font-medium text-[var(--text-primary)]" title={entry.key}>{entry.key}</span>
        <div class="flex shrink-0 items-center gap-2">
          <Badge tone="muted" appearance="surface" bordered>binary</Badge>
          <span class="font-mono text-[10px] text-[var(--text-muted)]">{formatBytes(entry.bytes)}</span>
        </div>
      </div>
    {/each}
  </div>

  <RelatedResourcesCard {resource} resourceType="configmaps" />

  <LabelsSection {labels} />
  <SmartAnnotationsCard {annotations} />
</div>
