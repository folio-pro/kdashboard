<script lang="ts">
  import { cn } from "$lib/utils";
  import { ScrollArea } from "$lib/components/ui/scroll-area";
  import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "$lib/components/ui/tooltip";
  import { ChevronRight, Pin, X } from "lucide-svelte";
  import type { CrdInfo } from "$lib/types/index.js";
  import SidebarSection from "./SidebarSection.svelte";
  import SidebarItem from "./SidebarItem.svelte";
  import ClusterRail from "./ClusterRail.svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { extensions } from "$lib/extensions";
  import { openResourceDetail, navigateToResourceTable, navigateToCrdTable } from "$lib/actions/navigation";
  import { settingsStore } from "$lib/stores/settings.svelte";
  import { topologyStore } from "$lib/stores/topology.svelte";
  import { costStore } from "$lib/stores/cost.svelte";
  import { securityStore } from "$lib/stores/security.svelte";
  import { helmStore } from "$lib/stores/helm.svelte";
  import { RESOURCE_SECTIONS } from "$lib/resource-catalog";

  const sections = RESOURCE_SECTIONS;

  function isItemActive(type: string): boolean {
    if (type === "portforwards") return uiStore.activeView === "portforwards";
    if (type === "topology") return uiStore.activeView === "topology";
    if (type === "cost") return uiStore.activeView === "cost";
    if (type === "security") return uiStore.activeView === "security";
    if (type === "helm") return uiStore.activeView === "helm";
    const view = uiStore.activeView;
    if (view !== "table" && view !== "details" && view !== "logs" && view !== "terminal" && view !== "yaml" && view !== "crd-table") return false;
    return k8sStore.pendingResourceType === type;
  }

  function handleItemClick(resourceType: string) {
    if (resourceType === "portforwards") {
      uiStore.showPortForwards();
      return;
    }
    if (resourceType === "topology") {
      uiStore.showTopology();
      topologyStore.loadNamespaceTopology(k8sStore.currentNamespace);
      return;
    }
    if (resourceType === "cost") {
      uiStore.showCost();
      costStore.loadCostOverview(k8sStore.currentNamespace);
      return;
    }
    if (resourceType === "helm") {
      uiStore.showHelm();
      helmStore.loadReleases(k8sStore.currentNamespace);
      return;
    }
    if (resourceType === "security") {
      uiStore.showSecurity();
      securityStore.loadSecurityOverview(k8sStore.currentNamespace);
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
  // them (only fetch the ones not already loaded).
  $effect(() => {
    for (const group of visibleCrdGroups) {
      const missing = group.resources.filter(
        (crd) => !(k8sStore.crdKey(crd) in k8sStore.crdCounts),
      );
      if (missing.length > 0) {
        k8sStore.loadCrdCounts(missing);
      }
    }
  });

</script>

<TooltipProvider delayDuration={300}>
  <aside
    class="flex h-full flex-row border-r border-t border-[var(--border-color)] bg-[var(--sidebar-bg)]"
  >
    {#if uiStore.sidebarCollapsed}
      <!-- Collapsed: single column with group labels + icons -->
      <div class="flex h-full w-full flex-col items-center py-2">
        <button
          class={cn(
            "mb-2 flex h-[42px] w-full items-center justify-center",
            "text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
          )}
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
              <div class="flex w-full flex-col items-center gap-[3px] border-t border-[var(--sidebar-hover)] py-[5px] mt-[5px] first:mt-0 first:border-t-0">
                <div class="flex h-4 w-[30px] items-center justify-center font-mono text-[7.5px] font-medium tracking-[0.06em] text-[var(--text-dimmed)]">
                  {section.abbr}
                </div>
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
              <span class="truncate text-[12.5px] font-semibold leading-tight text-[var(--text-primary)]" title={k8sStore.currentContext}>{k8sStore.currentContext}</span>
              <span class="truncate font-mono text-[10px] text-[var(--text-muted)]">{clusterSubline}</span>
            </div>
          </div>
        {/if}

        {#each extensions.mountsFor("sidebar-header") as mount (mount.id)}
          <mount.component />
        {/each}

        <!-- Flat list: one scroll for the whole tree, section headers stick
             to the top (plain overflow container so position:sticky works). -->
        <div class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-3.5">
          {#if settingsStore.pinnedResources.length > 0}
            <SidebarSection title="Pinned">
              {#each settingsStore.pinnedResources as pin}
                <div class="group flex w-full items-center border-l-2 border-transparent pr-[13px] transition-colors hover:bg-[var(--sidebar-hover)]">
                  <button
                    class={cn(
                      "flex min-w-0 flex-1 items-center gap-2.5 py-[6px] pl-[13px] text-left text-[12.5px] transition-colors",
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
                    <span class="shrink-0 font-mono text-[10px] text-[var(--text-dimmed)]">{pin.kind}</span>
                  </button>
                  <button
                    type="button"
                    class="shrink-0 pl-2 opacity-0 transition-opacity text-[var(--text-muted)] hover:text-[var(--status-failed)] focus-visible:opacity-100 group-hover:opacity-100"
                    onclick={() => settingsStore.unpinResource(pin.kind, pin.name, pin.namespace)}
                    title="Unpin"
                    aria-label={`Unpin ${pin.name}`}
                  >
                    <X class="h-3 w-3" />
                  </button>
                </div>
              {/each}
            </SidebarSection>
          {/if}

          {#each sections as section}
            <SidebarSection title={section.name}>
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
              <div class="px-[15px] py-2 text-[11.5px] leading-snug text-[var(--text-dimmed)]">
                {#if k8sStore.crdError.includes("orbidden") || k8sStore.crdError.includes("403")}
                  No permission to list CRDs in this cluster.
                {:else}
                  Failed to discover CRDs.
                {/if}
              </div>
            </SidebarSection>
          {:else if visibleCrdGroups.length > 0}
            {#each visibleCrdGroups as group}
              <SidebarSection title={group.group}>
                {#each group.resources as crd}
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
