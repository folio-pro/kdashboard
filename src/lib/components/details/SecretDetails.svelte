<script lang="ts">
  import { Lock, Copy, Check, KeyRound, ShieldCheck, Container } from "lucide-svelte";
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
  import { truncateValue } from "./pod-utils";
  import {
    decodeSecretValue,
    dockerRegistries,
    formatBytes,
    secretTypeLabel,
    tlsSummary,
  } from "./config-data.logic";

  interface Props {
    resource: Resource;
  }

  let { resource }: Props = $props();

  let labels = $derived(resource.metadata.labels ?? {});
  let annotations = $derived(resource.metadata.annotations ?? {});
  let type = $derived(resource.type ?? "Opaque");
  let data = $derived((resource.data ?? {}) as Record<string, string>);

  // Decode once per resource: every row reads its entry from here, so a
  // reveal toggle never re-decodes the whole Secret.
  let entries = $derived(
    Object.entries(data)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({ key, ...decodeSecretValue(String(value ?? "")) })),
  );

  let tls = $derived(type === "kubernetes.io/tls" ? tlsSummary(data) : null);
  let registries = $derived(
    type === "kubernetes.io/dockerconfigjson" || type === "kubernetes.io/dockercfg"
      ? dockerRegistries(type, data)
      : [],
  );

  // Reveal state is keyed by uid so a different Secret in the same tab (aside
  // preview) never starts revealed.
  let revealed = $state<Set<string>>(new Set());
  let revealedFor = "";
  $effect(() => {
    const uid = resource.metadata.uid;
    if (uid !== revealedFor) {
      revealedFor = uid;
      revealed = new Set();
    }
  });

  let revealableKeys = $derived(entries.filter((e) => !e.binary).map((e) => e.key));
  let allRevealed = $derived(revealableKeys.length > 0 && revealableKeys.every((k) => revealed.has(k)));

  function toggleRevealAll() {
    revealed = allRevealed ? new Set() : new Set(revealableKeys);
  }

  let copiedKey = $state<string | null>(null);

  async function copyValue(key: string, value: string) {
    await navigator.clipboard.writeText(value);
    copiedKey = key;
    setTimeout(() => { if (copiedKey === key) copiedKey = null; }, 1500);
  }

  function copyAll() {
    const lines = entries.filter((e) => !e.binary).map((e) => `${e.key}=${e.text}`);
    copyValue("__all__", lines.join("\n"));
  }
</script>

<div class="select-text">
  <MetadataSection {resource} />

  <DetailSection title="Secret" icon={Lock}>
    <KvGrid>
      <KvField label="Type">
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-mono text-[13px] text-[var(--text-primary)]">{type}</span>
          {#if secretTypeLabel(type) !== type}
            <Badge appearance="surface" bordered>{secretTypeLabel(type)}</Badge>
          {/if}
        </div>
      </KvField>
      <KvField label="Keys" value={entries.length} />
      {#if resource.metadata.annotations?.["kubernetes.io/service-account.name"]}
        <KvField label="Service Account" value={resource.metadata.annotations["kubernetes.io/service-account.name"]} />
      {/if}
      {#if tls}
        <KvField label="Certificate">
          <span class="flex items-center gap-1.5 font-mono text-[13px] {tls.hasCert ? 'text-[var(--status-running)]' : 'text-[var(--status-failed)]'}">
            <ShieldCheck class="h-3.5 w-3.5" />
            {tls.hasCert ? "tls.crt present" : "tls.crt missing"}
          </span>
        </KvField>
        <KvField label="Private key">
          <span class="flex items-center gap-1.5 font-mono text-[13px] {tls.hasKey ? 'text-[var(--status-running)]' : 'text-[var(--status-failed)]'}">
            <KeyRound class="h-3.5 w-3.5" />
            {tls.hasKey ? "tls.key present" : "tls.key missing"}
          </span>
        </KvField>
        {#if tls.hasCa}
          <KvField label="CA bundle" value="ca.crt present" mono={false} />
        {/if}
      {/if}
    </KvGrid>
  </DetailSection>

  {#if registries.length > 0}
    <DetailSection title="Registries" icon={Container}>
      {#snippet actions()}
        <span class="font-mono text-[11px] text-[var(--text-muted)]">{registries.length}</span>
      {/snippet}
      <div class="flex flex-col gap-2">
        {#each registries as reg (reg.registry)}
          <div class="flex items-center gap-3 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2.5">
            <span class="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--text-primary)]">{reg.registry}</span>
            {#if reg.username}
              <span class="shrink-0 text-[11px] text-[var(--text-muted)]">as <span class="font-mono text-[var(--text-secondary)]">{reg.username}</span></span>
            {/if}
          </div>
        {/each}
      </div>
    </DetailSection>
  {/if}

  <!-- Data: hidden by default, per-key reveal, reveal all / copy all. Mirrors
       the pod's "Config & Secrets" card so the two read the same. -->
  <div class="border-b border-[var(--border-color)]" data-testid="secret-data">
    <div class="flex items-center justify-between px-6 py-4">
      <span class="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">Data</span>
      <div class="flex items-center gap-3">
        {#if revealableKeys.length > 0}
          <Button variant="link" size="inline-xs" onclick={copyAll}>
            {copiedKey === "__all__" ? "copied!" : "copy all"}
          </Button>
          <Button variant="link" size="inline-xs" onclick={toggleRevealAll}>
            {allRevealed ? "hide all" : "reveal all"}
          </Button>
        {/if}
        <span class="font-mono text-[11px] text-[var(--text-muted)]">{entries.length}</span>
      </div>
    </div>

    {#if entries.length === 0}
      <div class="px-6 pb-4">
        <span class="text-[12px] text-[var(--text-muted)]">This Secret has no data</span>
      </div>
    {/if}

    {#each entries as entry (entry.key)}
      {@const isRevealed = revealed.has(entry.key)}
      <div class="border-t border-[var(--border-hover)] px-6 py-3">
        <div class="mb-1 flex items-center justify-between gap-3">
          <span class="min-w-0 truncate font-mono text-[12px] font-medium text-[var(--text-primary)]" title={entry.key}>{entry.key}</span>
          <div class="flex h-5 shrink-0 items-center gap-2">
            <span class="font-mono text-[10px] text-[var(--text-muted)]">{formatBytes(entry.bytes)}</span>
            {#if entry.binary}
              <Badge tone="muted" appearance="surface" bordered>binary</Badge>
            {:else}
              <Button
                variant="muted"
                size="icon-xs"
                class={isRevealed ? "visible" : "invisible"}
                onclick={() => copyValue(entry.key, entry.text)}
                title="Copy value"
                tabindex={isRevealed ? 0 : -1}
              >
                {#if copiedKey === entry.key}
                  <Check class="h-3 w-3 text-[var(--status-running)]" />
                {:else}
                  <Copy class="h-3 w-3" />
                {/if}
              </Button>
              <Button variant="link" size="inline-xs" onclick={() => (revealed = toggleSetItem(revealed, entry.key))}>
                {isRevealed ? "hide" : "reveal"}
              </Button>
            {/if}
          </div>
        </div>
        {#if entry.binary}
          <div class="rounded-sm border border-[var(--border-hover)] bg-[var(--bg-primary)] px-3 py-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
            Binary value ({formatBytes(entry.bytes)}) — not valid UTF-8, shown only in the YAML tab.
          </div>
        {:else if isRevealed}
          <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-sm border border-[var(--border-hover)] bg-[var(--bg-primary)] px-3 py-2 font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]">{truncateValue(entry.text, 4000)}</pre>
        {:else}
          <div class="rounded-sm border border-[var(--border-hover)] bg-[var(--bg-primary)] px-3 py-2 text-[11px] leading-relaxed text-[var(--text-muted)]">••••••••</div>
        {/if}
      </div>
    {/each}
  </div>

  <RelatedResourcesCard {resource} resourceType="secrets" />

  <LabelsSection {labels} />
  <SmartAnnotationsCard {annotations} />
</div>
