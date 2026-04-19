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
  import LazyView from "$lib/components/common/LazyView.svelte";
  import { ToastContainer } from "$lib/components/ui/toast";
  import ContextMenu from "$lib/components/context-menu/ContextMenu.svelte";
  import UpdateBanner from "$lib/components/common/UpdateBanner.svelte";
  import ConnectionErrorOverlay from "$lib/components/common/ConnectionErrorOverlay.svelte";
  import ScaleDialog from "$lib/components/details/ScaleDialog.svelte";
  import ConfirmDialog from "$lib/components/common/ConfirmDialog.svelte";
  import { extensions } from "$lib/extensions";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore, viewShowsTitleBar } from "$lib/stores/ui.svelte";
  import { settingsStore } from "$lib/stores/settings.svelte";
  import { dialogStore } from "$lib/stores/dialogs.svelte";
  import { deleteResource } from "$lib/actions/registry";
  import { initKeyboardShortcuts } from "$lib/utils/keyboard";
  import { handleTabSwitch } from "$lib/utils/tabLifecycle";

  // Synchronous hook: restore cached data BEFORE the view changes
  // (prevents empty state flash). Implementation lives in tabLifecycle
  // util so the race-guard + namespace sync logic is unit-testable.
  uiStore.onBeforeTabSwitch = (fromTab, toTab) => {
    handleTabSwitch(fromTab, toTab, k8sStore);
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
          tab.cacheReady = false;
        }
      }
    });
  });

  async function confirmGlobalDelete() {
    const resource = dialogStore.deleteResource;
    if (!resource) return;
    dialogStore.closeDelete();
    await deleteResource(resource);
  }

  let cleanupKeyboard: (() => void) | undefined;

  onMount(() => {
    // Fire init completely async — never block the render
    initApp();

    cleanupKeyboard = initKeyboardShortcuts();
    return () => cleanupKeyboard?.();
  });

  async function initApp() {
    try {
      await settingsStore.loadSettings();
    } catch (err) {
      // Defaults already applied — log so debugging isn't blind.
      console.error("[initApp] settings load failed (using defaults)", err);
    }

    // Close splash before the (possibly slow) cluster connection so the
    // themed UI is visible while k8s calls hang.
    invoke("close_splashscreen").catch(() => {});

    // Per-step try/catch so a late failure doesn't mask an earlier one and
    // the user message reflects the real cause.
    try {
      await k8sStore.loadContexts();
    } catch (err) {
      console.error("[initApp] loadContexts failed", err);
      k8sStore.connectionStatus = "error";
      k8sStore.error = "Failed to load kubeconfig contexts. Check your kubeconfig file.";
      return;
    }

    try {
      await k8sStore.restoreConnection(
        settingsStore.settings.context,
        settingsStore.settings.namespace,
      );
    } catch (err) {
      console.error("[initApp] restoreConnection failed", err);
      k8sStore.connectionStatus = "error";
      k8sStore.error = "Failed to connect to cluster. Check your kubeconfig credentials.";
      return;
    }

    try {
      await k8sStore.loadNamespaces();
    } catch (err) {
      console.error("[initApp] loadNamespaces failed", err);
      k8sStore.connectionStatus = "error";
      k8sStore.error = "Connected, but failed to list namespaces. Check RBAC permissions.";
      return;
    }

    // Fire-and-forget: sidebar counts are nice-to-have, never block init.
    void k8sStore.loadAllResourceCounts().catch((err) => {
      console.error("[initApp] loadAllResourceCounts failed", err);
    });
  }
</script>

<!--
  Global contextmenu handler prevents the native browser menu everywhere.
  Individual components (table rows, editors) stop propagation to show
  their own menus. The a11y_no_static_element_interactions warning is
  suppressed because this div is a chrome container, not an interactive
  control.
-->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="sidebar-grid h-screen w-screen select-none overflow-hidden bg-[var(--bg-primary)]"
  style="grid-template-columns: {uiStore.sidebarCollapsed
    ? 'var(--sidebar-width-collapsed)'
    : 'var(--sidebar-width-expanded)'} 1fr"
  oncontextmenu={(e) => e.preventDefault()}
>
  <!-- Sidebar -->
  <Sidebar />

  <!-- Main Content Area -->
  <div class="flex min-w-0 flex-1 overflow-hidden border-t border-[var(--border-color)]">
    <!-- Main Content -->
    <div class="main-content flex min-w-0 flex-1 flex-col">
      <!-- Tab Bar -->
      <TabBar />

      <!-- Title Bar (hidden in views that render their own header) -->
      {#if viewShowsTitleBar(uiStore.activeView)}
        <TitleBar />
      {/if}

      <!-- Content Area: one view at a time -->
      <div class="min-h-0 flex-1">
        {#if uiStore.activeView === "overview"}
          <LazyView
            loader={() => import("$lib/components/overview/OverviewDashboard.svelte")}
            name="overview"
          />
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
          <LazyView
            loader={() => import("$lib/components/settings/SettingsView.svelte")}
            name="settings"
          />
        {:else if uiStore.activeView === "topology"}
          <LazyView
            loader={() => import("$lib/components/topology/TopologyView.svelte")}
            name="topology"
          />
        {:else if uiStore.activeView === "cost"}
          <LazyView
            loader={() => import("$lib/components/cost/CostView.svelte")}
            name="cost"
          />
        {:else if uiStore.activeView === "security"}
          <LazyView
            loader={() => import("$lib/components/security/SecurityView.svelte")}
            name="security"
          />
        {:else if uiStore.activeView === "crd-table"}
          <LazyView
            loader={() => import("$lib/components/crd/CrdTableView.svelte")}
            name="CRDs"
          />
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
