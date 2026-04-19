<script lang="ts">
  import { ChevronRight, FileText, Lock, Copy, Check } from "lucide-svelte";
  import { invoke } from "@tauri-apps/api/core";
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
</script>

{#snippet configEntry(res: Resource, expandKey: string, subtitle: string, isSecret: boolean)}
  {@const dataEntries = Object.entries(res.data ?? {})}
  {@const isExpanded = expandedConfigs.has(expandKey)}
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
          <span class="text-[11px] text-[var(--text-muted)]">{subtitle} · {dataEntries.length} key{dataEntries.length !== 1 ? 's' : ''}</span>
        </div>
      </div>
      <ChevronRight class="h-3.5 w-3.5 shrink-0 text-[var(--text-dimmed)] transition-transform {isExpanded ? 'rotate-90' : ''}" />
    </button>
    {#if isExpanded}
      {#each dataEntries as [key, value]}
        {@const displayValue = isSecret ? decodeBase64(String(value ?? "")) : String(value ?? "")}
        {@const revealKey = `${expandKey}:${key}`}
        {@const isRevealed = !isSecret || revealedSecrets.has(revealKey)}
        <div class="border-t border-[var(--border-hover)] px-5 py-3">
          <div class="mb-1 flex items-center justify-between">
            <span class="text-[11px] font-medium text-[var(--text-muted)]">{key}</span>
            <div class="flex h-5 items-center gap-2">
              <button
                class="flex items-center text-[var(--text-dimmed)] hover:text-[var(--text-primary)] {isRevealed ? 'visible' : 'invisible'}"
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
            <div class="rounded border border-[var(--border-hover)] bg-[var(--bg-primary)] px-3 py-2 text-[11px] leading-relaxed text-[var(--text-dimmed)]">••••••••</div>
          {/if}
        </div>
      {/each}
      {#if dataEntries.length === 0}
        <div class="border-t border-[var(--border-hover)] px-5 py-3">
          <span class="text-[11px] text-[var(--text-dimmed)]">No data</span>
        </div>
      {/if}
    {/if}
  </div>
{/snippet}

<div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
  <div class="flex items-center justify-between px-5 py-4">
    <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">ConfigMaps & Secrets</h3>
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
      <span class="text-[11px] text-[var(--text-muted)]">
        {#if configLoading}
          loading...
        {:else}
          {fetchedConfigMaps.length + fetchedSecrets.length} resources
        {/if}
      </span>
    </div>
  </div>

  {#if !configLoading && fetchedConfigMaps.length === 0 && fetchedSecrets.length === 0}
    <div class="border-t border-[var(--border-hover)] px-5 py-4">
      <span class="text-xs text-[var(--text-muted)]">No configmaps or secrets referenced</span>
    </div>
  {/if}

  {#each fetchedConfigMaps as cm}
    {@render configEntry(cm, `cm:${cm.metadata.name}`, "ConfigMap", false)}
  {/each}

  {#each fetchedSecrets as sec}
    {@render configEntry(sec, `sec:${sec.metadata.name}`, sec.type ?? "Opaque", true)}
  {/each}
</div>
