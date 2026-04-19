<script lang="ts">
  import { ArrowUpRight, Layers, Server, FileText, Lock, HardDrive, Network, Shield, Box } from "lucide-svelte";
  import type { Resource, ResourceList } from "$lib/types";
  import { getRelatedResources, displayKind, type RelatedResource } from "$lib/utils/related-resources";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { openRelatedResourceTab } from "$lib/actions/navigation";
  import { invoke } from "@tauri-apps/api/core";
  import { onMount } from "svelte";

  interface Props {
    resource: Resource;
    resourceType: string;
  }

  let { resource, resourceType }: Props = $props();

  let allServices = $state<Resource[]>([]);

  const SERVICE_MATCHABLE_TYPES = new Set(["pods", "deployments", "replicasets", "statefulsets", "daemonsets"]);

  // Load services for reverse selector matching (only for workload types)
  onMount(() => {
    if (!SERVICE_MATCHABLE_TYPES.has(resourceType)) return;
    let cancelled = false;
    invoke<ResourceList>("list_resources", {
      resourceType: "services",
      namespace: k8sStore.currentNamespace,
    }).then((result) => {
      if (!cancelled) allServices = result.items;
    }).catch(() => {
      // non-critical, just won't show service matches
    });
    return () => { cancelled = true; };
  });

  let related = $derived(getRelatedResources(resource, resourceType, allServices));

  // Group related resources by category for visual chunking (Miller's Law)
  interface CategoryGroup {
    label: string;
    icon: typeof Layers;
    color: string;
    items: RelatedResource[];
  }

  const CATEGORY_MAP: Record<string, { label: string; icon: typeof Layers; color: string }> = {
    // Workloads
    ReplicaSet: { label: "Workloads", icon: Layers, color: "var(--status-running)" },
    Deployment: { label: "Workloads", icon: Layers, color: "var(--status-running)" },
    StatefulSet: { label: "Workloads", icon: Layers, color: "var(--status-running)" },
    DaemonSet: { label: "Workloads", icon: Layers, color: "var(--status-running)" },
    Job: { label: "Workloads", icon: Layers, color: "var(--status-running)" },
    CronJob: { label: "Workloads", icon: Layers, color: "var(--status-running)" },
    // Networking
    Service: { label: "Network", icon: Network, color: "var(--accent)" },
    Ingress: { label: "Network", icon: Network, color: "var(--accent)" },
    Ext: { label: "Network", icon: Network, color: "var(--accent)" },
    // Infrastructure
    Node: { label: "Infrastructure", icon: Server, color: "var(--status-pending)" },
    // Config
    ConfigMap: { label: "Configuration", icon: FileText, color: "var(--status-running)" },
    Secret: { label: "Configuration", icon: Lock, color: "var(--status-pending)" },
    SA: { label: "Configuration", icon: Shield, color: "var(--status-pending)" },
    // Storage
    PersistentVolumeClaim: { label: "Storage", icon: HardDrive, color: "var(--text-muted)" },
    PersistentVolume: { label: "Storage", icon: HardDrive, color: "var(--text-muted)" },
    StorageClass: { label: "Storage", icon: HardDrive, color: "var(--text-muted)" },
    "PVC Template": { label: "Storage", icon: HardDrive, color: "var(--text-muted)" },
    // RBAC
    Role: { label: "RBAC", icon: Shield, color: "var(--status-pending)" },
    ClusterRole: { label: "RBAC", icon: Shield, color: "var(--status-pending)" },
    RoleBinding: { label: "RBAC", icon: Shield, color: "var(--status-pending)" },
    ClusterRoleBinding: { label: "RBAC", icon: Shield, color: "var(--status-pending)" },
  };

  const DEFAULT_CATEGORY = { label: "Other", icon: Box, color: "var(--text-muted)" };

  let groups = $derived.by((): CategoryGroup[] => {
    const map = new Map<string, CategoryGroup>();
    for (const rel of related) {
      const cat = CATEGORY_MAP[rel.kind] ?? DEFAULT_CATEGORY;
      let group = map.get(cat.label);
      if (!group) {
        group = { label: cat.label, icon: cat.icon, color: cat.color, items: [] };
        map.set(cat.label, group);
      }
      group.items.push(rel);
    }
    return [...map.values()];
  });

  function navigate(rel: RelatedResource) {
    if (!rel.resourceType) return;
    openRelatedResourceTab(rel.resourceType, rel.name, resource.metadata.namespace);
  }
</script>

{#if related.length > 0}
  <div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
    <div class="flex items-center justify-between px-5 py-4">
      <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">Related Resources</h3>
      <span class="text-[11px] text-[var(--text-muted)]">{related.length}</span>
    </div>

    {#each groups as group}
      {@const Icon = group.icon}
      <!-- Category header -->
      <div class="flex items-center gap-2 border-t border-[var(--border-hover)] bg-[var(--bg-primary)] px-5 py-2">
        <Icon class="h-3 w-3 shrink-0" color={group.color} />
        <span class="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-dimmed)]">{group.label}</span>
        <span class="text-[10px] text-[var(--text-dimmed)]">{group.items.length}</span>
      </div>

      <!-- Items in this category -->
      {#each group.items as rel}
        {@const navigable = !!rel.resourceType}
        {#if navigable}
          <button
            class="related-item flex w-full items-center gap-3 border-t border-[var(--border-hover)] px-5 py-2.5 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
            onclick={() => navigate(rel)}
          >
            <span
              class="inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded px-2 py-0.5 text-[10px] font-semibold leading-tight border border-[var(--border-color)] bg-[var(--bg-tertiary)]"
              style:color={group.color}
              style:border-color="{group.color}30"
              style:background-color="{group.color}08"
            >
              {displayKind(rel.kind)}
            </span>
            <span class="min-w-0 flex-1 truncate font-mono text-[12px] font-medium text-[var(--text-primary)]" title={rel.name}>
              {rel.name}
            </span>
            <ArrowUpRight class="related-arrow h-3.5 w-3.5 shrink-0 text-[var(--text-dimmed)] transition-transform" />
          </button>
        {:else}
          <div class="flex items-center gap-3 border-t border-[var(--border-hover)] px-5 py-2.5">
            <span class="inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded px-2 py-0.5 text-[10px] font-medium leading-tight border border-[var(--border-color)] bg-[var(--bg-primary)] text-[var(--text-dimmed)]">
              {displayKind(rel.kind)}
            </span>
            <span class="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--text-muted)]" title={rel.name}>
              {rel.name}
            </span>
          </div>
        {/if}
      {/each}
    {/each}
  </div>
{/if}

<style>
  .related-item:hover :global(.related-arrow) {
    transform: translate(1px, -1px);
  }
</style>
