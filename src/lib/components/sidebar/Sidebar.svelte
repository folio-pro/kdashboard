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

  interface SectionDef {
    name: string;
    key: string;
    items: Array<{ name: string; type: string; badge?: number }>;
  }

  const sections: SectionDef[] = [
    {
      name: "Workloads",
      key: "workloads",
      items: [
        { name: "Pods", type: "pods" },
        { name: "Deployments", type: "deployments" },
        { name: "Replica Sets", type: "replicasets" },
        { name: "Stateful Sets", type: "statefulsets" },
        { name: "Daemon Sets", type: "daemonsets" },
        { name: "Jobs", type: "jobs" },
        { name: "Cron Jobs", type: "cronjobs" },
      ],
    },
    {
      name: "Network",
      key: "network",
      items: [
        { name: "Services", type: "services" },
        { name: "Ingresses", type: "ingresses" },
        { name: "Port Forwards", type: "portforwards" },
      ],
    },
    {
      name: "Configuration",
      key: "configuration",
      items: [
        { name: "Config Maps", type: "configmaps" },
        { name: "Secrets", type: "secrets" },
      ],
    },
    {
      name: "Scaling",
      key: "scaling",
      items: [
        { name: "HPA", type: "hpa" },
        { name: "VPA", type: "vpa" },
      ],
    },
    {
      name: "Storage",
      key: "storage",
      items: [
        { name: "Persistent Volumes", type: "persistentvolumes" },
        { name: "Persistent Volume Claims", type: "persistentvolumeclaims" },
        { name: "Storage Classes", type: "storageclasses" },
      ],
    },
    {
      name: "RBAC",
      key: "rbac",
      items: [
        { name: "Roles", type: "roles" },
        { name: "Role Bindings", type: "rolebindings" },
        { name: "Cluster Roles", type: "clusterroles" },
        { name: "Cluster Role Bindings", type: "clusterrolebindings" },
      ],
    },
    {
      name: "Policy",
      key: "policy",
      items: [
        { name: "Network Policies", type: "networkpolicies" },
        { name: "Resource Quotas", type: "resourcequotas" },
        { name: "Limit Ranges", type: "limitranges" },
        { name: "Pod Disruption Budgets", type: "poddisruptionbudgets" },
      ],
    },
    {
      name: "Cluster",
      key: "cluster",
      items: [
        { name: "Nodes", type: "nodes" },
        { name: "Namespaces", type: "namespaces" },
        { name: "Topology", type: "topology" },
        { name: "Security", type: "security" },
      ],
    },
  ];

  function getItemCount(type: string): number | undefined {
    if (type === "portforwards") return k8sStore.portForwards.length;
    if (type === "topology" || type === "cost" || type === "security") return undefined;
    return k8sStore.resourceCounts[type];
  }

  function isItemActive(type: string): boolean {
    if (type === "overview") return uiStore.activeView === "overview";
    if (type === "portforwards") return uiStore.activeView === "portforwards";
    if (type === "topology") return uiStore.activeView === "topology";
    if (type === "cost") return uiStore.activeView === "cost";
    if (type === "security") return uiStore.activeView === "security";
    const view = uiStore.activeView;
    if (view !== "table" && view !== "details" && view !== "logs" && view !== "terminal" && view !== "yaml" && view !== "crd-table") return false;
    return k8sStore.pendingResourceType === type;
  }

  function handleItemClick(resourceType: string) {
    if (resourceType === "overview") {
      k8sStore.setResourceType("");
      uiStore.showOverview();
      return;
    }
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
    if (resourceType === "security") {
      uiStore.showSecurity();
      securityStore.loadSecurityOverview(k8sStore.currentNamespace);
      return;
    }
    const item = sections.flatMap((s) => s.items).find((i) => i.type === resourceType);
    navigateToResourceTable(item?.name ?? resourceType, resourceType);
  }

  function toggleSection(key: string) {
    settingsStore.toggleCollapsedSection(key);
  }

  function handleCrdClick(crd: CrdInfo) {
    navigateToCrdTable(crd);
  }

  // Total CRD count for collapse threshold.
  // Guard on crdLoading/crdError so a failing discover_crds call doesn't
  // retrigger itself (the catch path used to reset crdGroups = [], which
  // together with this effect produced an infinite loop).
  $effect(() => {
    if (
      k8sStore.connectionStatus === "connected" &&
      k8sStore.crdGroups.length === 0 &&
      !k8sStore.crdLoading &&
      !k8sStore.crdError
    ) {
      k8sStore.discoverCrds();
    }
  });

  // Load counts for expanded CRD groups (only fetch if not already loaded)
  $effect(() => {
    for (const group of k8sStore.crdGroups) {
      const sectionKey = `crd-${group.group}`;
      if (!settingsStore.isSectionCollapsed(sectionKey)) {
        const missing = group.resources.filter(
          (crd) => !(k8sStore.crdKey(crd) in k8sStore.crdCounts),
        );
        if (missing.length > 0) {
          k8sStore.loadCrdCounts(missing);
        }
      }
    }
  });

</script>

<TooltipProvider delayDuration={300}>
  <aside
    class="flex h-full flex-row border-r border-t border-[var(--border-color)] bg-[var(--sidebar-bg)]"
  >
    {#if uiStore.sidebarCollapsed}
      <!-- Collapsed: single column with icons -->
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
          <div class="flex flex-col items-center px-1">
            <!-- Overview (collapsed) -->
            <Tooltip>
              <TooltipTrigger>
                <SidebarItem
                  name="Overview"
                  resourceType="overview"
                  active={isItemActive("overview")}
                  collapsed={true}
                  onclick={() => handleItemClick("overview")}
                />
              </TooltipTrigger>
              <TooltipContent side="right">
                <p>Overview</p>
              </TooltipContent>
            </Tooltip>
            <div class="my-1.5 h-px w-5 bg-[var(--border-color)]"></div>

            {#each sections as section, sectionIdx}
              {#if sectionIdx > 0}
                <div class="my-1.5 h-px w-5 bg-[var(--border-color)]"></div>
              {/if}
              <div class="flex w-full flex-col items-center gap-0.5">
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
        {#each extensions.mountsFor("sidebar-header") as mount (mount.id)}
          <mount.component />
        {/each}

        <ScrollArea class="flex-1 py-2">
          <div class="flex flex-col gap-2">
            <!-- Overview (always first) -->
            <div class="px-1">
              <SidebarItem
                name="Overview"
                resourceType="overview"
                active={isItemActive("overview")}
                collapsed={false}
                onclick={() => handleItemClick("overview")}
              />
            </div>

            {#if settingsStore.pinnedResources.length > 0}
              <SidebarSection
                title="Pinned"
                collapsed={settingsStore.isSectionCollapsed("pinned")}
                sidebarCollapsed={false}
                ontoggle={() => toggleSection("pinned")}
              >
                {#each settingsStore.pinnedResources as pin}
                  <button
                    class={cn(
                      "group flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs transition-colors",
                      "text-[var(--text-secondary)] hover:bg-[var(--sidebar-hover)] hover:text-[var(--text-primary)]"
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
                    <Pin class="h-3 w-3 shrink-0 text-[var(--text-muted)]" />
                    <span class="min-w-0 flex-1 truncate">{pin.name}</span>
                    <span class="shrink-0 text-[10px] text-[var(--text-dimmed)]">{pin.kind}</span>
                    <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
                    <span
                      class="shrink-0 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity text-[var(--text-muted)] hover:text-[var(--status-failed)]"
                      role="button"
                      tabindex="-1"
                      onclick={(e) => {
                        e.stopPropagation();
                        settingsStore.unpinResource(pin.kind, pin.name, pin.namespace);
                      }}
                      title="Unpin"
                    >
                      <X class="h-3 w-3" />
                    </span>
                  </button>
                {/each}
              </SidebarSection>
            {/if}

            {#each sections as section}
              <SidebarSection
                title={section.name}
                collapsed={settingsStore.isSectionCollapsed(section.key)}
                sidebarCollapsed={false}
                ontoggle={() => toggleSection(section.key)}
              >
                {#each section.items as item}
                  <SidebarItem
                    name={item.name}
                    resourceType={item.type}
                    active={isItemActive(item.type)}
                    collapsed={false}
                    onclick={() => handleItemClick(item.type)}
                  />
                {/each}
              </SidebarSection>
            {/each}

            <!-- CRD Discovery: Custom Resources -->
            {#if k8sStore.crdGroups.length > 0}
              {#each k8sStore.crdGroups as group}
                <SidebarSection
                  title={group.group}
                  collapsed={settingsStore.isSectionCollapsed(`crd-${group.group}`)}
                  sidebarCollapsed={false}
                  ontoggle={() => toggleSection(`crd-${group.group}`)}
                >
                  {#each group.resources as crd}
                    <SidebarItem
                      name={crd.kind}
                      resourceType={`crd:${crd.group}/${crd.kind}`}
                      active={k8sStore.selectedCrd?.kind === crd.kind && k8sStore.selectedCrd?.group === crd.group && uiStore.activeView === "crd-table"}
                      collapsed={false}
                      onclick={() => handleCrdClick(crd)}
                    />
                  {/each}
                </SidebarSection>
              {/each}
            {/if}
          </div>
        </ScrollArea>
      </div>
    {/if}
  </aside>
</TooltipProvider>
