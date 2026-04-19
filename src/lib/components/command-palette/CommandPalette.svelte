<script lang="ts">
  import { cn } from "$lib/utils";
  import { invoke } from "@tauri-apps/api/core";
  import { Dialog, DialogContent } from "$lib/components/ui/dialog";
  import Command from "$lib/components/ui/command/Command.svelte";
  import CommandInput from "$lib/components/ui/command/CommandInput.svelte";
  import CommandList from "$lib/components/ui/command/CommandList.svelte";
  import CommandEmpty from "$lib/components/ui/command/CommandEmpty.svelte";
  import CommandGroup from "$lib/components/ui/command/CommandGroup.svelte";
  import CommandItem from "$lib/components/ui/command/CommandItem.svelte";
  import {
    Box, Layers, Globe, FileText, Lock, Server, FolderOpen,
    Network, Database, Copy, Play, Clock, GitBranch, TrendingUp,
    Settings as SettingsIcon, Terminal, RefreshCw, ScrollText,
    Trash2, ClipboardCopy, Tag,
  } from "lucide-svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { dialogStore } from "$lib/stores/dialogs.svelte";
  import { extensions } from "$lib/extensions";
  import { restartWorkload, rollbackDeployment, SCALABLE_TYPES, RESTARTABLE_TYPES } from "$lib/actions/registry";
  import { navigateToResourceTable, navigateToCrdTable } from "$lib/actions/navigation";
  import { toastStore } from "$lib/stores/toast.svelte";
  import type { CommandPaletteItem } from "$lib/types";
  import {
    CATEGORY_ORDER,
    filterCommandItems,
    groupByCategory,
    orderGroups,
  } from "./command-palette";

  let query = $state("");
  let selectedIndex = $state(0);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resourceIconMap: Record<string, any> = {
    pods: Box,
    deployments: Layers,
    services: Globe,
    configmaps: FileText,
    secrets: Lock,
    nodes: Server,
    namespaces: FolderOpen,
    ingresses: Network,
    statefulsets: Database,
    daemonsets: Copy,
    jobs: Play,
    cronjobs: Clock,
    replicasets: GitBranch,
    hpa: TrendingUp,
    vpa: TrendingUp,
    persistentvolumes: Database,
    persistentvolumeclaims: Database,
    storageclasses: Database,
    roles: Lock,
    rolebindings: Lock,
    clusterroles: Lock,
    clusterrolebindings: Lock,
    networkpolicies: Network,
    resourcequotas: Tag,
    limitranges: Tag,
    poddisruptionbudgets: Tag,
  };

  const resourceTypes = [
    { type: "pods", label: "Pods" },
    { type: "deployments", label: "Deployments" },
    { type: "replicasets", label: "Replica Sets" },
    { type: "statefulsets", label: "Stateful Sets" },
    { type: "daemonsets", label: "Daemon Sets" },
    { type: "jobs", label: "Jobs" },
    { type: "cronjobs", label: "Cron Jobs" },
    { type: "services", label: "Services" },
    { type: "ingresses", label: "Ingresses" },
    { type: "configmaps", label: "Config Maps" },
    { type: "secrets", label: "Secrets" },
    { type: "hpa", label: "HPA" },
    { type: "vpa", label: "VPA" },
    { type: "nodes", label: "Nodes" },
    { type: "namespaces", label: "Namespaces" },
    { type: "persistentvolumes", label: "Persistent Volumes" },
    { type: "persistentvolumeclaims", label: "Persistent Volume Claims" },
    { type: "storageclasses", label: "Storage Classes" },
    { type: "roles", label: "Roles" },
    { type: "rolebindings", label: "Role Bindings" },
    { type: "clusterroles", label: "Cluster Roles" },
    { type: "clusterrolebindings", label: "Cluster Role Bindings" },
    { type: "networkpolicies", label: "Network Policies" },
    { type: "resourcequotas", label: "Resource Quotas" },
    { type: "limitranges", label: "Limit Ranges" },
    { type: "poddisruptionbudgets", label: "Pod Disruption Budgets" },
  ];

  const scalableTypes = SCALABLE_TYPES;
  const restartableTypes = RESTARTABLE_TYPES;

  const categoryOrder = CATEGORY_ORDER;

  let allItems = $derived.by(() => {
    const items: CommandPaletteItem[] = [];

    // --- Resource Actions (only when a resource is selected) ---
    const selected = k8sStore.selectedResource;
    if (selected) {
      const resName = selected.metadata.name;
      const resNamespace = selected.metadata.namespace ?? "";
      const resType = k8sStore.selectedResourceType;
      const supportsLogs = resType === "pods" || resType === "deployments";

      if (supportsLogs) {
        items.push({
          id: "res-action-logs",
          label: "View Logs",
          description: `Show logs for ${resName}`,
          category: "Resource Actions",
          action: () => {
            uiStore.showLogs();
            close();
          },
        });
      }

      if (resType === "pods") {
        items.push({
          id: "res-action-terminal",
          label: "Open Terminal",
          description: `Exec into ${resName}`,
          category: "Resource Actions",
          action: () => {
            uiStore.showTerminal();
            close();
          },
        });
      }

      // Scale action for scalable resources
      if (scalableTypes.includes(resType)) {
        items.push({
          id: "res-action-scale",
          label: "Scale",
          description: `Scale ${resName}`,
          category: "Resource Actions",
          action: () => {
            dialogStore.openScale(selected);
            close();
          },
        });
      }

      // Restart action for workloads
      if (restartableTypes.includes(resType)) {
        items.push({
          id: "res-action-restart",
          label: "Restart",
          description: `Restart ${resName}`,
          category: "Resource Actions",
          action: async () => {
            close();
            try {
              await restartWorkload(selected);
            } catch (err) {
              toastStore.error("Restart failed", String(err));
            }
          },
        });
      }

      // Rollback action for deployments
      if (resType === "deployments") {
        items.push({
          id: "res-action-rollback",
          label: "Rollback",
          description: `Rollback ${resName}`,
          category: "Resource Actions",
          action: async () => {
            close();
            try {
              await rollbackDeployment(selected);
            } catch (err) {
              toastStore.error("Rollback failed", String(err));
            }
          },
        });
      }

      items.push({
        id: "res-action-delete",
        label: "Delete Resource",
        description: `Delete ${resName}`,
        category: "Resource Actions",
        action: () => {
          dialogStore.openDelete(selected);
          close();
        },
      });

      items.push({
        id: "res-action-copy-name",
        label: "Copy Name",
        description: `Copy "${resName}" to clipboard`,
        category: "Resource Actions",
        action: async () => {
          await navigator.clipboard.writeText(resName);
          close();
        },
      });

      if (resNamespace) {
        items.push({
          id: "res-action-copy-ns",
          label: "Copy Namespace",
          description: `Copy "${resNamespace}" to clipboard`,
          category: "Resource Actions",
          action: async () => {
            await navigator.clipboard.writeText(resNamespace);
            close();
          },
        });
      }
    }

    // --- Resource navigation ---
    for (const rt of resourceTypes) {
      items.push({
        id: `resource-${rt.type}`,
        label: rt.label,
        description: `View ${rt.label}`,
        category: "Resources",
        action: () => {
          navigateToResourceTable(rt.label, rt.type);
          close();
        },
      });
    }

    // --- CRD Resources ---
    for (const group of k8sStore.crdGroups) {
      for (const crd of group.resources) {
        items.push({
          id: `crd-${crd.group}-${crd.kind}`,
          label: crd.kind,
          description: `${crd.group} — Custom Resource`,
          category: "Custom Resources",
          action: () => {
            navigateToCrdTable(crd);
            close();
          },
        });
      }
    }

    // --- Contexts ---
    for (const ctx of k8sStore.contexts) {
      items.push({
        id: `context-${ctx}`,
        label: ctx,
        description: "Switch context",
        category: "Contexts",
        action: () => {
          void (async () => {
            uiStore.resetForContextChange();
            await extensions.emit({ type: "context-changed", contextName: ctx });
            await k8sStore.switchContext(ctx);
          })();
          close();
        },
      });
    }

    // --- Namespaces ---
    for (const ns of k8sStore.namespaces) {
      items.push({
        id: `namespace-${ns}`,
        label: ns,
        description: "Switch namespace",
        category: "Namespaces",
        action: () => {
          k8sStore.switchNamespace(ns);
          close();
        },
      });
    }

    // --- General actions ---
    items.push(
      {
        id: "action-settings",
        label: "Open Settings",
        description: "Configure theme, density, and more",
        category: "Actions",
        hint: "\u2318,",
        action: () => {
          uiStore.toggleSettings();
          close();
        },
      },
      {
        id: "action-logs",
        label: "Show Logs",
        description: "Open the log viewer",
        category: "Actions",
        hint: "\u2318L",
        action: () => {
          uiStore.showLogs();
          close();
        },
      },
      {
        id: "action-terminal",
        label: "Open Terminal",
        description: "Start terminal session",
        category: "Actions",
        hint: "\u2318T",
        action: () => {
          uiStore.showTerminal();
          close();
        },
      },
      {
        id: "action-refresh",
        label: "Refresh Resources",
        description: "Reload current resource list",
        category: "Actions",
        action: () => {
          k8sStore.refreshResources();
          close();
        },
      },
    );

    // --- Extension-registered commands ---
    // Extensions may contribute additional palette items (e.g., audit log).
    // Wrap their `action` so the palette closes after the item runs,
    // matching core behavior.
    for (const cmd of extensions.commands) {
      items.push({
        ...cmd,
        action: () => {
          cmd.action();
          close();
        },
      });
    }

    return items;
  });

  let filteredItems = $derived.by(() => filterCommandItems(allItems, query));

  let groupedItems = $derived.by(() => groupByCategory(filteredItems));

  let orderedGroups = $derived.by(() => orderGroups(groupedItems, categoryOrder));

  $effect(() => {
    query;
    selectedIndex = 0;
  });

  function close() {
    uiStore.commandPaletteOpen = false;
    query = "";
    selectedIndex = 0;
  }

  function handleOpenChange(open: boolean) {
    if (!open) close();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || (e.key === "j" && e.ctrlKey)) {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, filteredItems.length - 1);
      return;
    }
    if (e.key === "ArrowUp" || (e.key === "k" && e.ctrlKey)) {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = filteredItems[selectedIndex];
      if (item) item.action();
      return;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function getItemIcon(item: CommandPaletteItem): any {
    // Items from extensions may carry their own icon.
    if (item.icon) return item.icon;
    if (item.category === "Resources") {
      const type = item.id.replace("resource-", "");
      return resourceIconMap[type] ?? Box;
    }
    if (item.category === "Contexts") return Server;
    if (item.category === "Namespaces") return FolderOpen;
    // Resource Actions
    if (item.id === "res-action-logs") return ScrollText;
    if (item.id === "res-action-terminal") return Terminal;
    if (item.id === "res-action-scale") return TrendingUp;
    if (item.id === "res-action-restart") return RefreshCw;
    if (item.id === "res-action-rollback") return GitBranch;
    if (item.id === "res-action-delete") return Trash2;
    if (item.id === "res-action-copy-name") return ClipboardCopy;
    if (item.id === "res-action-copy-ns") return Tag;
    // General actions
    if (item.id === "action-settings") return SettingsIcon;
    if (item.id === "action-logs") return ScrollText;
    if (item.id === "action-terminal") return Terminal;
    if (item.id === "action-refresh") return RefreshCw;
    return Box;
  }
</script>

<Dialog open={uiStore.commandPaletteOpen} onOpenChange={handleOpenChange}>
  <DialogContent class="overflow-hidden p-0 shadow-2xl sm:max-w-[520px]">
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div onkeydown={handleKeydown}>
      <Command>
        <CommandInput
          placeholder="Search resources, contexts, actions..."
          value={query}
          oninput={(e: Event) => { query = (e.target as HTMLInputElement).value; }}
        />
        <CommandList class="max-h-[50vh]">
          {#if filteredItems.length === 0}
            <CommandEmpty>No results found — try different keywords</CommandEmpty>
          {/if}
          {#each orderedGroups as [category, items], groupIdx}
            {#if groupIdx > 0}
              <div class="mx-2 my-1 border-t border-[var(--border-color)]"></div>
            {/if}
            <CommandGroup heading={category}>
              {#each items as item}
                {@const globalIndex = filteredItems.indexOf(item)}
                {@const IconComp = getItemIcon(item)}
                <CommandItem
                  class={cn(
                    "gap-2.5",
                    globalIndex === selectedIndex && "bg-[var(--bg-secondary)]"
                  )}
                  onclick={() => item.action()}
                  onmouseenter={() => (selectedIndex = globalIndex)}
                >
                  <IconComp class="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                  <div class="flex-1">
                    <span class="text-xs font-medium">{item.label}</span>
                    {#if item.description}
                      <span class="ml-2 text-[10px] text-[var(--text-muted)]">{item.description}</span>
                    {/if}
                  </div>
                  {#if item.hint}
                    <kbd class="shrink-0 rounded border border-[var(--border-color)] px-1.5 py-0.5 text-[9px] text-[var(--text-muted)]">
                      {item.hint}
                    </kbd>
                  {/if}
                  {#if globalIndex === selectedIndex}
                    <kbd class="shrink-0 rounded border border-[var(--border-color)] px-1.5 py-0.5 text-[9px] text-[var(--text-muted)]">
                      Enter
                    </kbd>
                  {/if}
                </CommandItem>
              {/each}
            </CommandGroup>
          {/each}
        </CommandList>
      </Command>
    </div>
  </DialogContent>
</Dialog>
