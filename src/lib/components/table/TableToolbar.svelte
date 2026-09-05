<script lang="ts">
  import { RefreshCw, Plus } from "lucide-svelte";
  import { Button } from "$lib/components/ui";
  import NamespacePicker from "$lib/components/common/NamespacePicker.svelte";
  import SavedViewTabs from "./SavedViewTabs.svelte";
  import FilterSearch from "./FilterSearch.svelte";
  import DensityToggle from "./DensityToggle.svelte";
  import ColumnPicker from "./ColumnPicker.svelte";
  import type { Column } from "$lib/types";
  import { isClusterScopedType } from "$lib/resource-catalog";
  import { k8sStore } from "$lib/stores/k8s.svelte";

  /**
   * One 44px bar: title, namespace, saved views, then the search box (which
   * holds the typed filters as chips), density, columns, refresh, Create.
   */
  interface Props {
    resourceTypeLabel: string;
    resourceType: string;
    isLoading: boolean;
    /** Every column the type defines, shown or hidden. */
    allColumns: Column[];
    namespaceAutoHidden: boolean;
    /** Row count each saved view would show, by view id. */
    viewCounts: Record<string, number>;
    onrefresh: () => void;
    oncreate: () => void;
  }

  let {
    resourceTypeLabel, resourceType, isLoading, allColumns, namespaceAutoHidden, viewCounts, onrefresh, oncreate,
  }: Props = $props();
</script>

<header
  class="flex h-[44px] shrink-0 items-center gap-2.5 border-b border-[var(--border-color)] bg-[var(--bg-primary)] pl-6 pr-4"
  data-drag-region
>
  <h1 class="shrink-0 text-[15px] font-semibold tracking-tight text-[var(--text-primary)]" data-drag-region>
    {resourceTypeLabel}
  </h1>

  <!-- A Node, a ClusterRole or a cluster-scoped CRD lives in no namespace: a
       picker here would promise a scope the list cannot have. -->
  {#if !isClusterScopedType(resourceType) && !k8sStore.isClusterScopedCrd(resourceType)}
    <NamespacePicker />
  {/if}

  <span class="h-[18px] w-px shrink-0 bg-[var(--border-color)]" aria-hidden="true"></span>

  <SavedViewTabs {resourceType} {viewCounts} />

  <FilterSearch {resourceTypeLabel} {allColumns} />

  <DensityToggle />

  <ColumnPicker {resourceType} {allColumns} {namespaceAutoHidden} />

  <Button
    variant="ghost"
    size="icon-sm"
    class="text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
    onclick={onrefresh}
    title="Refresh (r)"
    aria-label="Refresh"
  >
    <RefreshCw class="h-3.5 w-3.5 {isLoading ? 'animate-spin' : ''}" />
  </Button>

  <Button
    variant="accent"
    size="sm"
    class="font-semibold"
    onclick={oncreate}
    title="Create resources from YAML — write, paste or start from a template"
  >
    <Plus class="h-3.5 w-3.5" />
    Create
  </Button>
</header>
