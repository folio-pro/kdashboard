<script lang="ts">
  import { ChevronRight, FileText, Lock, Copy, Check, Search, X } from "lucide-svelte";
  import { invoke } from "$lib/ipc/core";
  import type { Resource, ResourceList } from "$lib/types";
  import { toggleSetItem } from "$lib/utils/k8s-helpers";
  import { decodeBase64, truncateValue, type ConfigRef } from "./pod-utils";

  interface Props {
    configResources: ConfigRef[];
    namespace: string;
  }

  let { configResources, namespace }: Props = $props();

  let fetchedConfigMaps = $state<Resource[]>([]);
  let fetchedSecrets = $state<Resource[]>([]);
  let configLoading = $state(true);

  $effect(() => {
    const refs = configResources;
    const ns = namespace;
    let cancelled = false;

    const cmNames = refs.filter(r => r.kind === "ConfigMap").map(r => r.name);
    const secNames = refs.filter(r => r.kind === "Secret").map(r => r.name);

    if (cmNames.length === 0 && secNames.length === 0) {
      fetchedConfigMaps = [];
      fetchedSecrets = [];
      configLoading = false;
      return;
    }

    configLoading = true;

    const promises: Promise<void>[] = [];

    if (cmNames.length > 0) {
      promises.push(
        invoke<ResourceList>("list_resources", {
          resourceType: "configmaps",
          namespace: ns,
        }).then((result) => {
          if (!cancelled) {
            fetchedConfigMaps = result.items.filter(item => cmNames.includes(item.metadata.name));
          }
        }).catch(() => {
          if (!cancelled) fetchedConfigMaps = [];
        })
      );
    }

    if (secNames.length > 0) {
      promises.push(
        invoke<ResourceList>("list_resources", {
          resourceType: "secrets",
          namespace: ns,
        }).then((result) => {
          if (!cancelled) {
            fetchedSecrets = result.items.filter(item => secNames.includes(item.metadata.name));
          }
        }).catch(() => {
          if (!cancelled) fetchedSecrets = [];
        })
      );
    }

    Promise.all(promises).finally(() => {
      if (!cancelled) configLoading = false;
    });

    return () => { cancelled = true; };
  });

  let expandedConfigs = $state<Set<string>>(new Set());
  let revealedSecrets = $state<Set<string>>(new Set());

  let allExpandKeys = $derived([
    ...fetchedConfigMaps.map(cm => `cm:${cm.metadata.name}`),
    ...fetchedSecrets.map(sec => `sec:${sec.metadata.name}`),
  ]);
  let allRevealKeys = $derived(
    fetchedSecrets.flatMap(sec =>
      Object.keys(sec.data ?? {}).map(key => `sec:${sec.metadata.name}:${key}`)
    )
  );
  let allRevealed = $derived(
    allExpandKeys.length > 0 &&
    allExpandKeys.every(k => expandedConfigs.has(k)) &&
    allRevealKeys.every(k => revealedSecrets.has(k))
  );

  function toggleRevealAll() {
    if (allRevealed) {
      revealedSecrets = new Set();
    } else {
      expandedConfigs = new Set([...expandedConfigs, ...allExpandKeys]);
      revealedSecrets = new Set(allRevealKeys);
    }
  }

  let copiedKey = $state<string | null>(null);

  async function copyValue(key: string, value: string) {
    await navigator.clipboard.writeText(value);
    copiedKey = key;
    setTimeout(() => { if (copiedKey === key) copiedKey = null; }, 1500);
  }

  function copyAllConfigs() {
    const lines: string[] = [];
    for (const cm of fetchedConfigMaps) {
      for (const [key, value] of Object.entries(cm.data ?? {})) {
        lines.push(`${cm.metadata.name}/${key}=${String(value ?? "")}`);
      }
    }
    for (const sec of fetchedSecrets) {
      for (const [key, value] of Object.entries(sec.data ?? {})) {
        lines.push(`${sec.metadata.name}/${key}=${decodeBase64(String(value ?? ""))}`);
      }
    }
    copyValue("__all__", lines.join("\n"));
  }

  // --- Key search/filter ---
  let keyFilter = $state("");
  let filterLower = $derived(keyFilter.trim().toLowerCase());

  function matchKey(key: string): boolean {
    return !filterLower || key.toLowerCase().includes(filterLower);
  }

  let totalMatches = $derived(
    !filterLower
      ? 0
      : [...fetchedConfigMaps, ...fetchedSecrets]
          .flatMap((r) => Object.keys(r.data ?? {}))
          .filter(matchKey).length
  );
</script>

{#snippet configEntry(res: Resource, expandKey: string, subtitle: string, isSecret: boolean)}
  {@const dataEntries = Object.entries(res.data ?? {})}
  {@const matchedEntries = filterLower ? dataEntries.filter(([k]) => matchKey(k)) : dataEntries}
  {@const isExpanded = filterLower ? true : expandedConfigs.has(expandKey)}
  {#if !filterLower || matchedEntries.length > 0}
  <div class="border-t border-[var(--border-hover)]">
    <button
      class="flex w-full items-center justify-between px-5 py-3.5 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
      onclick={() => expandedConfigs = toggleSetItem(expandedConfigs, expandKey)}
    >
      <div class="flex items-center gap-2.5">
        {#if isSecret}
          <Lock class="h-3.5 w-3.5 shrink-0 text-[var(--status-pending)]" />
        {:else}
          <FileText class="h-3.5 w-3.5 shrink-0 text-[var(--status-running)]" />
        {/if}
        <div class="flex flex-col gap-0.5">
          <span class="truncate text-[13px] font-medium text-[var(--text-primary)]">{res.metadata.name}</span>
          <span class="text-[11px] text-[var(--text-muted)]">
            {subtitle} ·
            {#if filterLower}{matchedEntries.length} of {dataEntries.length} keys{:else}{dataEntries.length} key{dataEntries.length !== 1 ? 's' : ''}{/if}
          </span>
        </div>
      </div>
      <ChevronRight class="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)] transition-transform {isExpanded ? 'rotate-90' : ''}" />
    </button>
    {#if isExpanded}
      {#each matchedEntries as [key, value]}
        {@const displayValue = isSecret ? decodeBase64(String(value ?? "")) : String(value ?? "")}
        {@const revealKey = `${expandKey}:${key}`}
        {@const isRevealed = !isSecret || revealedSecrets.has(revealKey)}
        <div class="border-t border-[var(--border-hover)] px-5 py-3">
          <div class="mb-1 flex items-center justify-between">
            <span class="text-[11px] font-medium text-[var(--text-muted)]">{key}</span>
            <div class="flex h-5 items-center gap-2">
              <button
                class="flex items-center text-[var(--text-muted)] hover:text-[var(--text-primary)] {isRevealed ? 'visible' : 'invisible'}"
                onclick={() => copyValue(revealKey, displayValue)}
                title="Copy value"
                tabindex={isRevealed ? 0 : -1}
              >
                {#if copiedKey === revealKey}
                  <Check class="h-3 w-3 text-[var(--status-running)]" />
                {:else}
                  <Copy class="h-3 w-3" />
                {/if}
              </button>
              {#if isSecret}
                <button
                  class="text-[10px] font-medium text-[var(--accent)] hover:underline"
                  onclick={() => revealedSecrets = toggleSetItem(revealedSecrets, revealKey)}
                >
                  {isRevealed ? "hide" : "reveal"}
                </button>
              {/if}
            </div>
          </div>
          {#if isRevealed}
            <pre class="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded border border-[var(--border-hover)] bg-[var(--bg-primary)] px-3 py-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">{truncateValue(displayValue)}</pre>
          {:else}
            <div class="rounded border border-[var(--border-hover)] bg-[var(--bg-primary)] px-3 py-2 text-[11px] leading-relaxed text-[var(--text-muted)]">••••••••</div>
          {/if}
        </div>
      {/each}
      {#if dataEntries.length === 0}
        <div class="border-t border-[var(--border-hover)] px-5 py-3">
          <span class="text-[11px] text-[var(--text-muted)]">No data</span>
        </div>
      {/if}
    {/if}
  </div>
  {/if}
{/snippet}

<div class="border-b border-[var(--border-color)]">
  <div class="flex items-center justify-between px-6 py-4">
    <span class="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">Config &amp; Secrets</span>
    <div class="flex items-center gap-3">
      {#if !configLoading && (fetchedConfigMaps.length > 0 || fetchedSecrets.length > 0)}
        <button
          class="text-[10px] font-medium text-[var(--accent)] hover:underline"
          onclick={copyAllConfigs}
        >
          {copiedKey === "__all__" ? "copied!" : "copy all"}
        </button>
        <button
          class="text-[10px] font-medium text-[var(--accent)] hover:underline"
          onclick={toggleRevealAll}
        >
          {allRevealed ? "hide all" : "reveal all"}
        </button>
      {/if}
      <span class="font-mono text-[11px] text-[var(--text-muted)]">
        {#if configLoading}
          …
        {:else}
          {fetchedConfigMaps.length + fetchedSecrets.length}
        {/if}
      </span>
    </div>
  </div>

  {#if !configLoading && fetchedConfigMaps.length === 0 && fetchedSecrets.length === 0}
    <div class="px-6 pb-4">
      <span class="text-[12px] text-[var(--text-muted)]">No configmaps or secrets referenced</span>
    </div>
  {/if}

  <!-- Key search -->
  {#if !configLoading && (fetchedConfigMaps.length > 0 || fetchedSecrets.length > 0)}
    <div class="px-6 pb-3">
      <div class="focus-ring-host flex h-8 items-center gap-2 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2.5 transition-colors focus-within:border-[var(--accent)]">
        <Search class="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
        <input
          type="text"
          placeholder="Filter keys…"
          aria-label="Filter configmap and secret keys"
          bind:value={keyFilter}
          class="h-full flex-1 bg-transparent text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
        />
        {#if keyFilter}
          <span class="shrink-0 font-mono text-[10px] text-[var(--text-muted)]">{totalMatches}</span>
          <button class="shrink-0 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]" onclick={() => (keyFilter = "")} title="Clear">
            <X class="h-3.5 w-3.5" />
          </button>
        {/if}
      </div>
    </div>
  {/if}

  {#each fetchedConfigMaps as cm}
    {@render configEntry(cm, `cm:${cm.metadata.name}`, "ConfigMap", false)}
  {/each}

  {#each fetchedSecrets as sec}
    {@render configEntry(sec, `sec:${sec.metadata.name}`, sec.type ?? "Opaque", true)}
  {/each}

  {#if filterLower && totalMatches === 0 && (fetchedConfigMaps.length > 0 || fetchedSecrets.length > 0)}
    <div class="border-t border-[var(--border-hover)] px-6 py-4">
      <span class="text-[12px] text-[var(--text-muted)]">No keys match “{keyFilter}”</span>
    </div>
  {/if}
</div>
