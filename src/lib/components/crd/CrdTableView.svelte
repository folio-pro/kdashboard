<script lang="ts">
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { ScrollArea } from "$lib/components/ui/scroll-area";
  import { cn } from "$lib/utils";
  import { formatAge } from "$lib/utils/age";
  import { resolveJsonPath } from "$lib/utils/k8s-helpers";
  import CrdDetailPanel from "./CrdDetailPanel.svelte";
  import type { Resource } from "$lib/types/index.js";

  let selectedResource = $state<Resource | null>(null);
  let showDetail = $state(false);

  function handleRowClick(resource: Resource) {
    selectedResource = resource;
    showDetail = true;
  }

  function handleBack() {
    showDetail = false;
    selectedResource = null;
  }
</script>

{#if showDetail && selectedResource}
  <CrdDetailPanel
    resource={selectedResource}
    columns={k8sStore.crdResources.columns}
    onback={handleBack}
  />
{:else}
  <div class="flex h-full flex-col">
    <!-- Header -->
    <div class="flex items-center gap-2 border-b border-[var(--border-color)] px-4 py-2">
      {#if k8sStore.selectedCrd}
        <span class="text-xs text-[var(--text-muted)]">{k8sStore.selectedCrd.group}</span>
        <span class="text-xs text-[var(--text-muted)]">/</span>
        <span class="text-sm font-medium text-[var(--text-primary)]">{k8sStore.selectedCrd.kind}</span>
        <span class="text-xs text-[var(--text-muted)]">({k8sStore.crdResources.items.length})</span>
        {#if k8sStore.selectedCrd.scope === "Cluster"}
          <span class="ml-1 rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">cluster-scoped</span>
        {/if}
      {/if}
    </div>

    {#if k8sStore.isLoading}
      <div class="flex flex-1 items-center justify-center">
        <span class="text-xs text-[var(--text-muted)]">Loading...</span>
      </div>
    {:else if k8sStore.crdResources.items.length === 0}
      <div class="flex flex-1 items-center justify-center">
        <span class="text-xs text-[var(--text-muted)]">
          No {k8sStore.selectedCrd?.kind ?? "resources"} found
        </span>
      </div>
    {:else}
      <ScrollArea class="flex-1">
        <table class="w-full text-xs">
          <thead>
            <tr class="border-b border-[var(--border-color)] bg-[var(--bg-secondary)]">
              <th class="px-3 py-2 text-left font-medium text-[var(--text-secondary)]">Name</th>
              <th class="px-3 py-2 text-left font-medium text-[var(--text-secondary)]">Namespace</th>
              {#each k8sStore.crdResources.columns as col}
                <th class="px-3 py-2 text-left font-medium text-[var(--text-secondary)]" title={col.description}>
                  {col.name}
                </th>
              {/each}
              <th class="px-3 py-2 text-right font-medium text-[var(--text-secondary)]">Age</th>
            </tr>
          </thead>
          <tbody>
            {#each k8sStore.crdResources.items as resource}
              <tr
                class={cn(
                  "cursor-pointer border-b border-[var(--table-border)] transition-colors",
                  "hover:bg-[var(--table-row-hover)]",
                  selectedResource?.metadata?.uid === resource.metadata?.uid && "bg-[var(--table-row-selected)]"
                )}
                onclick={() => handleRowClick(resource)}
              >
                <td class="px-3 py-1.5 text-[var(--text-primary)]">{resource.metadata.name}</td>
                <td class="px-3 py-1.5 text-[var(--text-secondary)]">{resource.metadata.namespace ?? "—"}</td>
                {#each k8sStore.crdResources.columns as col}
                  <td class="px-3 py-1.5 text-[var(--text-secondary)]">
                    {resolveJsonPath(resource, col.json_path) || "—"}
                  </td>
                {/each}
                <td class="px-3 py-1.5 text-right text-[var(--text-muted)]">
                  {resource.metadata.creation_timestamp ? formatAge(resource.metadata.creation_timestamp) : "—"}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </ScrollArea>
    {/if}
  </div>
{/if}
