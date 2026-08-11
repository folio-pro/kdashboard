<script lang="ts">
  import { cn } from "$lib/utils";
  import { invoke } from "$lib/ipc/core";
  import { Dialog, DialogContent } from "$lib/components/ui/dialog";
  import Command from "$lib/components/ui/command/Command.svelte";
  import CommandInput from "$lib/components/ui/command/CommandInput.svelte";
  import CommandList from "$lib/components/ui/command/CommandList.svelte";
  import CommandEmpty from "$lib/components/ui/command/CommandEmpty.svelte";
  import CommandGroup from "$lib/components/ui/command/CommandGroup.svelte";
  import CommandItem from "$lib/components/ui/command/CommandItem.svelte";
  import {
    Server, FolderOpen, GitBranch, TrendingUp,
    Settings as SettingsIcon, Terminal, RefreshCw, ScrollText,
    Trash2, ClipboardCopy, Tag,
  } from "lucide-svelte";
  import { RESOURCE_ITEMS } from "$lib/resource-catalog";
  import { resourceIcon } from "$lib/resource-icons";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { dialogStore } from "$lib/stores/dialogs.svelte";
  import { extensions } from "$lib/extensions";
  import { restartWorkload, rollbackDeployment, SCALABLE_TYPES, RESTARTABLE_TYPES } from "$lib/actions/registry";
  import { navigateToResourceTable, navigateToCrdTable, switchContext } from "$lib/actions/navigation";
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

  const resourceTypes = RESOURCE_ITEMS.filter((i) => !i.virtual);

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
        label: rt.name,
        description: `View ${rt.name}`,
        category: "Resources",
        action: () => {
          navigateToResourceTable(rt.name, rt.type);
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
          void switchContext(ctx);
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
      return resourceIcon(type);
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
    return resourceIcon("");
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
                    <span class="text-[12px] font-medium">{item.label}</span>
                    {#if item.description}
                      <span class="ml-2 text-[10px] text-[var(--text-muted)]">{item.description}</span>
                    {/if}
                  </div>
                  {#if item.hint}
                    <kbd class="shrink-0 rounded border border-[var(--border-color)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
                      {item.hint}
                    </kbd>
                  {/if}
                  {#if globalIndex === selectedIndex}
                    <kbd class="shrink-0 rounded border border-[var(--border-color)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
                      Enter
                    </kbd>
                  {/if}
                </CommandItem>
              {/each}
            </CommandGroup>
          {/each}
        </CommandList>
      </Command>
      <!-- Footer hint bar (reference console parity) -->
      <div class="flex items-center gap-4 border-t border-[var(--border-color)] bg-[var(--bg-primary)] px-4 py-2 text-[11px] text-[var(--text-muted)]">
        <span class="flex items-center gap-1.5"><kbd class="rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-1 font-mono text-[10px] text-[var(--text-secondary)]">↑↓</kbd> Navigate</span>
        <span class="flex items-center gap-1.5"><kbd class="rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-1 font-mono text-[10px] text-[var(--text-secondary)]">↵</kbd> Open</span>
        <span class="flex items-center gap-1.5"><kbd class="rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-1 font-mono text-[10px] text-[var(--text-secondary)]">esc</kbd> Close</span>
      </div>
    </div>
  </DialogContent>
</Dialog>
