<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import Sidebar from "$lib/components/sidebar/Sidebar.svelte";
  import TitleBar from "$lib/components/titlebar/TitleBar.svelte";
  import ResourceTable from "$lib/components/table/ResourceTable.svelte";
  import DetailPanel from "$lib/components/details/DetailPanel.svelte";
  import StatusBar from "$lib/components/common/StatusBar.svelte";
  import CommandPalette from "$lib/components/command-palette/CommandPalette.svelte";
  import LogViewer from "$lib/components/logs/LogViewer.svelte";
  import TerminalView from "$lib/components/terminal/TerminalView.svelte";
  import PortForwardView from "$lib/components/port-forwards/PortForwardView.svelte";
  import YamlEditor from "$lib/components/details/YamlEditor.svelte";
  import TabBar from "$lib/components/tabs/TabBar.svelte";
  // Lazy-loaded views (secondary, not always needed)
  // SettingsView, TopologyView, CostView, SecurityView are loaded via
  // dynamic import below.
  import { ToastContainer } from "$lib/components/ui/toast";
  import ContextMenu from "$lib/components/context-menu/ContextMenu.svelte";
  import UpdateBanner from "$lib/components/common/UpdateBanner.svelte";
  import ConnectionErrorOverlay from "$lib/components/common/ConnectionErrorOverlay.svelte";
  import ScaleDialog from "$lib/components/details/ScaleDialog.svelte";
  import ConfirmDialog from "$lib/components/common/ConfirmDialog.svelte";
  import { extensions } from "$lib/extensions";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore, RESOURCE_TAB_TYPES } from "$lib/stores/ui.svelte";
  import { settingsStore } from "$lib/stores/settings.svelte";
  import { dialogStore } from "$lib/stores/dialogs.svelte";
  import { toastStore } from "$lib/stores/toast.svelte";
  import { initKeyboardShortcuts } from "$lib/utils/keyboard";

  // Synchronous hook: restore cached data BEFORE the view changes (prevents empty state flash)
  uiStore.onBeforeTabSwitch = (fromTab, toTab) => {
    // Save outgoing tab's selected resource
    if (fromTab && RESOURCE_TAB_TYPES.has(fromTab.type) && k8sStore.selectedResource) {
      fromTab.cachedResource = k8sStore.selectedResource;
    }
    // Skip save when store holds a different resource_type (in-flight load).
    if (fromTab && (fromTab.type === "table" || fromTab.type === "crd-table")) {
      if (
        fromTab.resourceType &&
        k8sStore.resources.resource_type === fromTab.resourceType
      ) {
        fromTab.cachedItems = k8sStore.resources.items;
        fromTab.count = k8sStore.resources.items.length;
      }
    }

    // Restore incoming tab's selected resource
    if (RESOURCE_TAB_TYPES.has(toTab.type) && toTab.cachedResource) {
      k8sStore.selectedResource = toTab.cachedResource;
    }

    if ((toTab.type === "table" || toTab.type === "crd-table") && toTab.resourceType) {
      // Empty cache means the prior load hadn't completed — refetch instead of
      // restoring a blank table.
      if (toTab.cachedItems && toTab.cachedItems.length > 0) {
        // Cached: set namespace synchronously (no async switchNamespace to avoid race)
        if (toTab.namespace !== undefined && toTab.namespace !== k8sStore.currentNamespace) {
          k8sStore.currentNamespace = toTab.namespace;
        }
        k8sStore.restoreResources(toTab.resourceType, toTab.cachedItems!);
      } else {
        // No cache: do full namespace switch + fetch
        if (toTab.namespace !== undefined && toTab.namespace !== k8sStore.currentNamespace) {
          k8sStore.switchNamespace(toTab.namespace);
        }
        k8sStore.isLoading = true;
        k8sStore.setResourceType(toTab.resourceType);
        k8sStore.resources = { items: [], resource_type: toTab.resourceType };
        const expectedType = toTab.resourceType;
        k8sStore.loadResources(toTab.resourceType).then(() => {
          if (k8sStore.selectedResourceType === expectedType) {
            toTab.cachedItems = k8sStore.resources.items;
            toTab.count = k8sStore.resources.items.length;
          }
        });
      }
    }
  };

  // When namespace changes, save it to the active tab and invalidate cache.
  // Writes to tab.* are wrapped in untrack so they don't retrigger this effect
  // via Svelte 5's deep $state proxy on the tabs array.
  $effect(() => {
    const ns = k8sStore.currentNamespace;
    untrack(() => {
      const tab = uiStore.activeTab;
      if (tab && (tab.type === "table" || tab.type === "crd-table")) {
        if (tab.namespace !== ns) {
          tab.namespace = ns;
          tab.cachedItems = undefined;
          tab.count = undefined;
        }
      }
    });
  });

  async function confirmGlobalDelete() {
    const resource = dialogStore.deleteResource;
    if (!resource) return;
    dialogStore.closeDelete();
    try {
      await invoke("delete_resource", {
        kind: resource.kind,
        name: resource.metadata.name,
        namespace: resource.metadata.namespace ?? "",
        uid: resource.metadata.uid,
        resource_version: resource.metadata.resource_version,
      });
      toastStore.success("Resource deleted", `${resource.kind} "${resource.metadata.name}" deleted`);
      k8sStore.selectResource(null);
      await k8sStore.refreshResources();
    } catch (err) {
      toastStore.error("Delete failed", String(err));
    }
  }

  let cleanupKeyboard: (() => void) | undefined;

  onMount(() => {
    // Fire init completely async — never block the render
    initApp();

    cleanupKeyboard = initKeyboardShortcuts();
    return () => cleanupKeyboard?.();
  });

  async function initApp() {
    // Phase 1: Settings (fast, reads from Rust state)
    try {
      await settingsStore.loadSettings();
    } catch {
      // Defaults already applied
    }

    // Phase 3: Close splash now — app is visible with theme
    invoke("close_splashscreen").catch(() => {});

    // Phase 3: K8s connection (can hang — app is already visible)
    try {
      await k8sStore.loadContexts();
      await k8sStore.restoreConnection(
        settingsStore.settings.context,
        settingsStore.settings.namespace,
      );
      await k8sStore.loadNamespaces();
      k8sStore.loadAllResourceCounts();
    } catch {
      k8sStore.connectionStatus = "error";
      k8sStore.error = "Failed to connect to cluster. Check your kubeconfig.";
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="sidebar-grid h-screen w-screen select-none overflow-hidden bg-[var(--bg-primary)]"
  style="grid-template-columns: {uiStore.sidebarCollapsed ? 44 : 260}px 1fr"
  oncontextmenu={(e) => {
    // Prevent default browser context menu app-wide
    // Individual components (table rows) handle their own contextmenu
    e.preventDefault();
  }}
>
  <!-- Sidebar -->
  <Sidebar />

  <!-- Main Content Area -->
  <div class="flex min-w-0 flex-1 overflow-hidden border-t border-[var(--border-color)]">
    <!-- Main Content -->
    <div class="main-content flex min-w-0 flex-1 flex-col">
      <!-- Tab Bar -->
      <TabBar />

      <!-- Title Bar / Header (hidden in detail view which has its own header) -->
      {#if uiStore.activeView === "table" || uiStore.activeView === "crd-table" || uiStore.activeView === "portforwards" || uiStore.activeView === "topology" || uiStore.activeView === "cost" || uiStore.activeView === "security"}
        <TitleBar />
      {/if}

      <!-- Content Area: one view at a time -->
      <div class="min-h-0 flex-1">
        {#if uiStore.activeView === "overview"}
          {#await import("$lib/components/overview/OverviewDashboard.svelte") then mod}
            <mod.default />
          {:catch}
            <p class="p-4 text-xs text-[var(--status-failed)]">Failed to load overview.</p>
          {/await}
        {:else if uiStore.activeView === "table"}
          <ResourceTable />
        {:else if uiStore.activeView === "details"}
          <DetailPanel />
        {:else if uiStore.activeView === "logs"}
          <LogViewer />
        {:else if uiStore.activeView === "terminal"}
          <TerminalView />
        {:else if uiStore.activeView === "portforwards"}
          <PortForwardView />
        {:else if uiStore.activeView === "yaml"}
          <YamlEditor />
        {:else if uiStore.activeView === "settings"}
          {#await import("$lib/components/settings/SettingsView.svelte") then mod}
            <mod.default />
          {:catch}
            <p class="p-4 text-xs text-[var(--status-failed)]">Failed to load settings view.</p>
          {/await}
        {:else if uiStore.activeView === "topology"}
          {#await import("$lib/components/topology/TopologyView.svelte") then mod}
            <mod.default />
          {:catch}
            <p class="p-4 text-xs text-[var(--status-failed)]">Failed to load topology view.</p>
          {/await}
        {:else if uiStore.activeView === "cost"}
          {#await import("$lib/components/cost/CostView.svelte") then mod}
            <mod.default />
          {:catch}
            <p class="p-4 text-xs text-[var(--status-failed)]">Failed to load cost view.</p>
          {/await}
        {:else if uiStore.activeView === "security"}
          {#await import("$lib/components/security/SecurityView.svelte") then mod}
            <mod.default />
          {:catch}
            <p class="p-4 text-xs text-[var(--status-failed)]">Failed to load security view.</p>
          {/await}
        {:else if uiStore.activeView === "crd-table"}
          {#await import("$lib/components/crd/CrdTableView.svelte") then mod}
            <mod.default />
          {:catch}
            <p class="p-4 text-xs text-[var(--status-failed)]">Failed to load CRD view.</p>
          {/await}
        {/if}
      </div>

      <!-- Status Bar -->
      <StatusBar />
    </div>

    {#each extensions.mountsFor("app-overlay") as mount (mount.id)}
      <mount.component />
    {/each}
  </div>
</div>

<!-- Overlays (outside grid to avoid layout interference) -->
{#if uiStore.commandPaletteOpen}
  <CommandPalette />
{/if}

<ContextMenu />

<!-- Global dialogs (triggered from context menu, command palette, or detail panel) -->
{#if dialogStore.scaleOpen && dialogStore.scaleResource}
  <ScaleDialog bind:open={dialogStore.scaleOpen} resource={dialogStore.scaleResource} />
{/if}

{#if dialogStore.deleteOpen && dialogStore.deleteResource}
  <ConfirmDialog
    open={dialogStore.deleteOpen}
    title="Delete {dialogStore.deleteResource.kind}"
    description={`Are you sure you want to delete ${dialogStore.deleteResource.kind} "${dialogStore.deleteResource.metadata.name}"${dialogStore.deleteResource.metadata.namespace ? ` in namespace "${dialogStore.deleteResource.metadata.namespace}"` : ''}? This action cannot be undone.`}
    confirmLabel="Delete {dialogStore.deleteResource.metadata.name}"
    cancelLabel="Keep {dialogStore.deleteResource.kind}"
    variant="destructive"
    onconfirm={confirmGlobalDelete}
    oncancel={() => dialogStore.closeDelete()}
  />
{/if}

<UpdateBanner />
<ConnectionErrorOverlay />
<ToastContainer />

{#if k8sStore.isSwitchingContext}
  <div class="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-[1px]">
    <div class="flex min-w-[260px] items-center gap-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-3 shadow-lg">
      <span class="h-4 w-4 animate-spin rounded-full border-2 border-[var(--text-muted)] border-t-[var(--accent)]"></span>
      <div class="flex flex-col">
        <span class="text-sm font-medium text-[var(--text-primary)]">Switching context...</span>
        {#if k8sStore.switchingContextTo}
          <span class="font-mono text-[11px] text-[var(--text-secondary)]">{k8sStore.switchingContextTo}</span>
        {/if}
      </div>
    </div>
  </div>
{/if}
