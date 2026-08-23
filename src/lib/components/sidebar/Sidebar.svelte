<script lang="ts">
  import { cn } from "$lib/utils";
  import { ScrollArea } from "$lib/components/ui/scroll-area";
  import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "$lib/components/ui/tooltip";
  import { ChevronRight, Pin, X } from "lucide-svelte";
  import { Button, SearchField } from "$lib/components/ui";
  import type { CrdInfo } from "$lib/types/index.js";
  import SidebarSection from "./SidebarSection.svelte";
  import SidebarItem from "./SidebarItem.svelte";
  import ClusterRail from "./ClusterRail.svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore, RESOURCE_TAB_TYPES, type ActiveView } from "$lib/stores/ui.svelte";
  import { extensions } from "$lib/extensions";
  import { openResourceDetail, navigateToResourceTable, navigateToCrdTable, openAppView, isAppView } from "$lib/actions/navigation";
  import { settingsStore } from "$lib/stores/settings.svelte";
  import { sidebarStore } from "$lib/stores/sidebar.svelte";
  import { RESOURCE_SECTIONS } from "$lib/resource-catalog";
  import { filterGroups, resourceMatches, crdMatches } from "./sidebar-filter";

  const sections = RESOURCE_SECTIONS;

  function isItemActive(type: string): boolean {
    if (isAppView(type)) return uiStore.activeView === type;

    // Views that sit "inside" a resource type, and so keep its catalog entry
    // lit. Derived from RESOURCE_TAB_TYPES rather than re-listing its members:
    // a hand-written copy would silently stop matching the moment a new
    // resource-bound view type was added to the set.
    const view = uiStore.activeView;
    if (view !== "table" && view !== "crd-table" && !RESOURCE_TAB_TYPES.has(view)) return false;

    // pendingResourceType, not selectedResourceType: the former is set the
    // instant a load is requested, so the highlight follows the click rather
    // than waiting for the list to arrive.
    return k8sStore.pendingResourceType === type;
  }

  function handleItemClick(resourceType: string) {
    if (isAppView(resourceType)) {
      openAppView(resourceType, k8sStore.currentNamespace);
      return;
    }
    const item = sections.flatMap((s) => s.items).find((i) => i.type === resourceType);
    navigateToResourceTable(item?.name ?? resourceType, resourceType);
  }

  function handleCrdClick(crd: CrdInfo) {
    navigateToCrdTable(crd);
  }

  let statusColor = $derived(
    k8sStore.connectionStatus === "connected"
      ? "var(--accent)"
      : k8sStore.connectionStatus === "connecting"
        ? "var(--status-pending)"
        : "var(--status-failed)"
  );

  // CRDs already surfaced as fixed sidebar items (Scaling): hide them from the
  // discovered groups so they don't appear twice.
  const FIXED_CRDS = new Set([
    "autoscaling.k8s.io/verticalpodautoscalers",
    "datadoghq.com/watermarkpodautoscalers",
  ]);

  let visibleCrdGroups = $derived(
    k8sStore.crdGroups
      .map((g) => ({
        ...g,
        resources: g.resources.filter((c) => !FIXED_CRDS.has(`${c.group}/${c.plural}`)),
      }))
      .filter((g) => g.resources.length > 0)
  );

  // --- Nav filter -----------------------------------------------------------
  // CRD discovery appends one section per API group, so a real cluster turns
  // the nav into dozens of sections in one unbounded scroll. The filter is
  // what makes that navigable; collapsing is what makes it tidy.
  let isFiltering = $derived(sidebarStore.filter.trim().length > 0);

  // Both lists are {title, items} groups, so one filter serves both.
  let filteredSections = $derived(
    filterGroups(
      sections.map((s) => ({ title: s.name, items: s.items })),
      sidebarStore.filter,
      resourceMatches,
    ),
  );

  let filteredCrdGroups = $derived(
    filterGroups(
      visibleCrdGroups.map((g) => ({ title: g.group, items: g.resources })),
      sidebarStore.filter,
      crdMatches,
    ),
  );

  let noMatches = $derived(
    isFiltering && filteredSections.length === 0 && filteredCrdGroups.length === 0
  );

  let clusterSubline = $derived.by(() => {
    const parts: string[] = [];
    const nodes = k8sStore.resourceCounts["nodes"];
    if (nodes !== undefined) parts.push(`${nodes} nodes`);
    parts.push(k8sStore.currentNamespace ? `ns/${k8sStore.currentNamespace}` : "all namespaces");
    return parts.join(" · ");
  });

  // Guard on crdDiscovered (not crdGroups.length — a cluster with zero CRDs
  // legitimately keeps that at 0, which retriggered discovery in a loop) and
  // on crdLoading/crdError so a failing discover_crds call doesn't
  // retrigger itself either.
  $effect(() => {
    if (
      k8sStore.connectionStatus === "connected" &&
      !k8sStore.crdDiscovered &&
      !k8sStore.crdLoading &&
      !k8sStore.crdError
    ) {
      k8sStore.discoverCrds();
    }
  });

  // Flat list: every CRD group is always visible, so load counts for all of
  // them (only fetch the ones not already loaded). One call for every group:
  // this effect reads crdCounts, which each response rewrites, so a call per
  // group re-ran it once per response and re-requested every group still
  // pending — O(groups²) get_crd_counts on connect. The store additionally
  // skips CRDs whose count is already in flight.
  $effect(() => {
    const missing: CrdInfo[] = [];
    for (const group of visibleCrdGroups) {
      for (const crd of group.resources) {
        if (!(k8sStore.crdKey(crd) in k8sStore.crdCounts)) missing.push(crd);
      }
    }
    if (missing.length > 0) k8sStore.loadCrdCounts(missing);
  });

</script>

<TooltipProvider delayDuration={300}>
  <aside
    class="flex h-full flex-row border-r border-[var(--border-color)] bg-[var(--sidebar-bg)]"
  >
    {#if uiStore.sidebarCollapsed}
      <!-- Collapsed: single column with group labels + icons -->
      <div class="flex h-full w-full flex-col items-center py-2">
        <!-- Full-bleed rail control: its shape is the layout, not a button box.
             Routing it through <Button> meant undoing the height, width and
             radius at the call site, which is the drift the primitives exist
             to stop. Tokens, not the component. -->
        <button
          class="mb-2 flex h-[42px] w-full items-center justify-center text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
          onclick={() => uiStore.toggleSidebar()}
          title="Expand sidebar"
        >
          <ChevronRight class="h-4 w-4" />
        </button>

        {#each extensions.mountsFor("sidebar-header") as mount (mount.id)}
          <mount.component />
        {/each}

        <ScrollArea class="flex-1 w-full">
          <div class="flex flex-col items-center">
            {#each sections as section}
              <!--
                The group used to be labelled with a 7.5px monospace
                abbreviation — unreadable, and redundant with the per-item
                tooltips. The rule separating the groups does the same job.
              -->
              <div class="flex w-full flex-col items-center gap-[3px] border-t border-[var(--sidebar-hover)] py-[5px] mt-[5px] first:mt-0 first:border-t-0">
                {#each section.items as item}
                  <Tooltip>
                    <TooltipTrigger>
                      <SidebarItem
                        name={item.name}
                        resourceType={item.type}
                        active={isItemActive(item.type)}
                        collapsed={true}
                        onclick={() => handleItemClick(item.type)}
                      />
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      <p>{item.name}</p>
                    </TooltipContent>
                  </Tooltip>
                {/each}
              </div>
            {/each}
          </div>
        </ScrollArea>

        {#each extensions.mountsFor("sidebar-footer") as mount (mount.id)}
          <mount.component />
        {/each}
      </div>
    {:else}
      <!-- Expanded: cluster rail + navigation -->
      <ClusterRail />

      <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
        <!-- Active cluster header: connection dot + context + at-a-glance
             cluster facts, matching the flat-list reference design. -->
        {#if k8sStore.currentContext}
          <div class="flex items-center gap-[9px] border-b border-[var(--border-color)] px-[13px] py-3">
            <span
              class="h-2 w-2 shrink-0 rounded-full"
              role="img"
              aria-label={`Connection ${k8sStore.connectionStatus}`}
              title={`Connection ${k8sStore.connectionStatus}`}
              style={`background: ${statusColor}; box-shadow: 0 0 0 3px color-mix(in srgb, ${statusColor} 16%, transparent);`}
            ></span>
            <div class="flex min-w-0 flex-1 flex-col">
              <span class="truncate text-[12px] font-semibold leading-tight text-[var(--text-primary)]" title={k8sStore.currentContext}>{k8sStore.currentContext}</span>
              <span class="truncate font-mono text-[10px] text-[var(--text-muted)]">{clusterSubline}</span>
            </div>
          </div>
        {/if}

        {#each extensions.mountsFor("sidebar-header") as mount (mount.id)}
          <mount.component />
        {/each}

        <!-- Nav filter: the only practical way through a cluster whose CRDs
             contribute dozens of sections. -->
        <div class="shrink-0 px-[13px] py-2">
          <SearchField
            size="sm"
            clearable
            placeholder="Filter resources..."
            ariaLabel="Filter sidebar resources"
            bind:value={sidebarStore.filter}
          />
        </div>

        <!-- One scroll for the whole tree, section headers stick to the top
             (plain overflow container so position:sticky works). -->
        <div class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-3.5">
          {#if noMatches}
            <p class="px-[15px] py-3 text-[11px] leading-snug text-[var(--text-muted)]">
              Nothing matches “{sidebarStore.filter}”.
            </p>
          {/if}

          {#if settingsStore.pinnedResources.length > 0 && !isFiltering}
            <SidebarSection title="Pinned">
              {#each settingsStore.pinnedResources as pin}
                <div class="group flex w-full items-center border-l-2 border-transparent pr-[13px] transition-colors hover:bg-[var(--sidebar-hover)]">
                  <button
                    class={cn(
                      "flex min-w-0 flex-1 items-center gap-2.5 py-[6px] pl-[13px] text-left text-[12px] transition-colors",
                      "text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]"
                    )}
                    onclick={async () => {
                      const found = await k8sStore.fetchResource(pin.resourceType, pin.name);
                      if (found) {
                        openResourceDetail(found, pin.resourceType);
                      } else {
                        uiStore.backToTable();
                      }
                    }}
                  >
                    <Pin class="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                    <span class="min-w-0 flex-1 truncate">{pin.name}</span>
                    <span class="shrink-0 font-mono text-[10px] text-[var(--text-muted)]">{pin.kind}</span>
                  </button>
                  <Button
                    type="button"
                    variant="muted"
                    size="icon-xs"
                    class="mr-1 shrink-0 opacity-0 transition-opacity hover:bg-transparent hover:text-[var(--status-failed)] focus-visible:opacity-100 group-hover:opacity-100"
                    onclick={() => settingsStore.unpinResource(pin.kind, pin.name, pin.namespace)}
                    title="Unpin"
                    aria-label={`Unpin ${pin.name}`}
                  >
                    <X class="h-3 w-3" />
                  </Button>
                </div>
              {/each}
            </SidebarSection>
          {/if}

          {#each filteredSections as section}
            <SidebarSection title={section.title} forceOpen={isFiltering}>
              {#each section.items as item}
                <SidebarItem
                  name={item.name}
                  resourceType={item.type}
                  short={item.short}
                  active={isItemActive(item.type)}
                  collapsed={false}
                  onclick={() => handleItemClick(item.type)}
                />
              {/each}
            </SidebarSection>
          {/each}

          <!-- CRD Discovery: Custom Resources -->
          {#if k8sStore.crdError}
            <SidebarSection title="Custom Resources">
              <div class="px-[15px] py-2 text-[11px] leading-snug text-[var(--text-muted)]">
                {#if k8sStore.crdError.includes("orbidden") || k8sStore.crdError.includes("403")}
                  No permission to list CRDs in this cluster.
                {:else}
                  Failed to discover CRDs.
                {/if}
              </div>
            </SidebarSection>
          {:else if filteredCrdGroups.length > 0}
            {#each filteredCrdGroups as group}
              <SidebarSection title={group.title} forceOpen={isFiltering}>
                {#each group.items as crd}
                  <SidebarItem
                    name={crd.kind}
                    resourceType={`crd:${crd.group}/${crd.kind}`}
                    short={crd.short_names[0]}
                    active={k8sStore.selectedCrd?.kind === crd.kind && k8sStore.selectedCrd?.group === crd.group && uiStore.activeView === "crd-table"}
                    collapsed={false}
                    onclick={() => handleCrdClick(crd)}
                  />
                {/each}
              </SidebarSection>
            {/each}
          {/if}
        </div>
      </div>
    {/if}
  </aside>
</TooltipProvider>
