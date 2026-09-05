<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { Spinner } from "$lib/components/ui";
  import { invoke } from "$lib/ipc/core";
  import Sidebar from "$lib/components/sidebar/Sidebar.svelte";
  import WindowTitleBar from "$lib/components/titlebar/WindowTitleBar.svelte";
  import ResourceTable from "$lib/components/table/ResourceTable.svelte";
  import StatusBar from "$lib/components/common/StatusBar.svelte";
  import CommandPalette from "$lib/components/command-palette/CommandPalette.svelte";
  import TabBar from "$lib/components/tabs/TabBar.svelte";
  import LazyView from "$lib/components/common/LazyView.svelte";
  // DetailPanel (pulls in the yaml parser ~97 kB), LogViewer, TerminalView and
  // YamlEditor pull in large vendor chunks (CodeMirror ~495 kB, wterm ~52 kB)
  // so they're loaded via LazyView to keep the initial bundle small.
  import { ToastContainer } from "$lib/components/ui/toast";
  import ContextMenu from "$lib/components/context-menu/ContextMenu.svelte";
  import UpdateBanner from "$lib/components/common/UpdateBanner.svelte";
  import ConnectionErrorOverlay from "$lib/components/common/ConnectionErrorOverlay.svelte";
  import ScaleDialog from "$lib/components/details/ScaleDialog.svelte";
  import DrainDialog from "$lib/components/details/DrainDialog.svelte";
  import CompareDialog from "$lib/components/details/CompareDialog.svelte";
  import QuickEditDialog from "$lib/components/details/QuickEditDialog.svelte";
  import ConfirmDialog from "$lib/components/common/ConfirmDialog.svelte";
  import WorkloadConfirmDialogs from "$lib/components/details/WorkloadConfirmDialogs.svelte";
  import AgentApprovalDialog from "$lib/components/agent/AgentApprovalDialog.svelte";
  import { agentStore } from "$lib/stores/agent.svelte";
  import { extensions } from "$lib/extensions";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore, RESOURCE_TAB_TYPES } from "$lib/stores/ui.svelte";
  import { settingsStore } from "$lib/stores/settings.svelte";
  import { portForwardStore } from "$lib/stores/port-forwards.svelte";
  import { alertStore } from "$lib/stores/alerts.svelte";
  import { dialogStore } from "$lib/stores/dialogs.svelte";
  import { deleteResource } from "$lib/actions/registry";
  import { initKeyboardShortcuts } from "$lib/utils/keyboard";
  import { handleTabSwitch } from "$lib/utils/tabLifecycle";

  // Synchronous hook: restore cached data BEFORE the view changes
  // (prevents empty state flash). Implementation lives in tabLifecycle
  // util so the race-guard + namespace sync logic is unit-testable.
  uiStore.onBeforeTabSwitch = (fromTab, toTab) => {
    handleTabSwitch(fromTab, toTab, k8sStore, (tabId) => uiStore.activeTabId === tabId);
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
    // loadContexts reports its failure through the store rather than by
    // throwing. Without contexts nothing below can work, and a later step's
    // own failure would overwrite the message the overlay is showing.
    if (k8sStore.connectionStatus !== "connected") return;

    // Benchmark mode (env KDASH_BENCH=1): drive the real list path and exit.
    try {
      const { maybeRunBenchmark } = await import("$lib/benchmark/e2e-runner");
      if (await maybeRunBenchmark()) return;
    } catch (err) {
      console.error("[initApp] benchmark run failed", err);
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

    // The namespace list and the restored tab's data are fetched TOGETHER.
    // Listing namespaces is the slowest boot call on a remote cluster (the
    // list plus one access review per namespace, in waves of 16), and the
    // tab's list does not need it: with no namespace list loaded yet,
    // restoreNamespace() trusts the persisted namespace as-is. Waiting for
    // the namespaces first cost the table a full round of that latency.
    const namespacesLoaded = k8sStore.loadNamespaces();

    // Re-hydrate the restored active tab so it isn't blank on cold boot. The
    // selected resource and visible list are ephemeral (never persisted), so a
    // details/logs/yaml or table tab restored from a previous session has no
    // data until something fetches it — initApp never did, which left a
    // restored pod-detail tab showing an empty panel.
    try {
      await bootstrapActiveTab();
    } catch (err) {
      console.error("[initApp] bootstrapActiveTab failed", err);
    }

    // A namespace-list failure is reported by the store (loadNamespaces never
    // throws) and is not fatal: a restricted-RBAC user can still work in the
    // persisted namespace, which the tab above already listed.
    try {
      await namespacesLoaded;
    } catch (err) {
      console.error("[initApp] loadNamespaces failed", err);
    }

    // The restored namespace may not exist in THIS cluster — snap to a real
    // one now that the cluster's namespace list is known, and refetch the tab
    // if that moved it (the list above was for the namespace that is gone).
    const restoredNamespace = k8sStore.currentNamespace;
    k8sStore.restoreNamespace();
    if (k8sStore.currentNamespace !== restoredNamespace) {
      try {
        await bootstrapActiveTab();
      } catch (err) {
        console.error("[initApp] bootstrapActiveTab (namespace snapped) failed", err);
      }
    }

    // Fire-and-forget: sidebar counts are nice-to-have, never block init.
    void k8sStore.loadAllResourceCounts().catch((err) => {
      console.error("[initApp] loadAllResourceCounts failed", err);
    });

    // Saved forwards flagged auto-start come up with the restored context;
    // alert polling starts only if something is watched.
    portForwardStore.onContextConnected(k8sStore.currentContext);
    alertStore.ensurePolling();
  }

  /**
   * Fetch the data the restored active tab needs to render. Table tabs load
   * their list; resource-bound views (details/logs/yaml/terminal) re-select
   * their resource by reference. No-op for views that carry no resource.
   */
  async function bootstrapActiveTab() {
    const tab = uiStore.activeTab;
    if (!tab) return;

    // Adopt the tab's namespace only when it is usable in this cluster.
    k8sStore.restoreNamespace(tab.namespace);

    if (tab.type === "table" && tab.resourceType) {
      await k8sStore.loadResources(tab.resourceType);
      return;
    }

    if (RESOURCE_TAB_TYPES.has(tab.type) && tab.resourceType && tab.resourceName) {
      await k8sStore.selectResourceByRef(tab.resourceType, tab.resourceName, tab.namespace);
    }
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
<div class="flex h-screen w-screen select-none flex-col overflow-hidden bg-[var(--bg-primary)]">
  <!-- Persistent window title bar (VSCode-style): always present, draggable,
       hosts the macOS traffic lights. -->
  <WindowTitleBar />

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="sidebar-grid min-h-0 w-full flex-1 overflow-hidden"
    style="grid-template-columns: {uiStore.sidebarCollapsed
      ? 'var(--sidebar-width-collapsed)'
      : 'var(--sidebar-width-expanded)'} 1fr"
    oncontextmenu={(e) => e.preventDefault()}
  >
    <!-- Sidebar -->
    <Sidebar />

    <!-- Main Content Area -->
    <div class="flex min-w-0 flex-1 overflow-hidden">
    <!-- Main Content -->
    <div class="main-content flex min-w-0 flex-1 flex-col">
      <!-- Tab Bar -->
      <TabBar />

      <!--
        Content Area: one view at a time. Each view now owns its header. The
        app used to stack a shared TitleBar above this, which in Cost /
        Security / Helm / Topology / Port Forwards / CRDs landed on top of the
        view's OWN header, showing the last table's title and a search box
        that filtered nothing.
      -->
      <div class="min-h-0 flex-1">
        {#if uiStore.activeView === "table"}
          <ResourceTable />
        {:else if uiStore.activeView === "details"}
          <LazyView
            loader={() => import("$lib/components/details/DetailPanel.svelte")}
            name="details"
          />
        {:else if uiStore.activeView === "logs"}
          <LazyView
            loader={() => import("$lib/components/logs/LogViewer.svelte")}
            name="logs"
          />
        {:else if uiStore.activeView === "terminal"}
          <LazyView
            loader={() => import("$lib/components/terminal/TerminalView.svelte")}
            name="terminal"
          />
        {:else if uiStore.activeView === "portforwards"}
          <LazyView
            loader={() => import("$lib/components/port-forwards/PortForwardView.svelte")}
            name="port forwards"
          />
        {:else if uiStore.activeView === "yaml"}
          <LazyView
            loader={() => import("$lib/components/details/YamlEditor.svelte")}
            name="YAML editor"
          />
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
        {:else if uiStore.activeView === "helm"}
          <LazyView
            loader={() => import("$lib/components/helm/HelmView.svelte")}
            name="Helm releases"
          />
        {:else if uiStore.activeView === "crd-table"}
          <LazyView
            loader={() => import("$lib/components/crd/CrdTableView.svelte")}
            name="CRDs"
          />
        {:else if uiStore.activeView === "overview"}
          <LazyView
            loader={() => import("$lib/components/overview/OverviewView.svelte")}
            name="overview"
          />
        {:else if uiStore.activeView === "problems"}
          <LazyView
            loader={() => import("$lib/components/overview/ProblemsView.svelte")}
            name="problems"
          />
        {/if}
      </div>

      <!-- AI Agent bottom panel (lazy: WTerm ~52 kB only when opened) -->
      {#if agentStore.panelOpen}
        <LazyView
          loader={() => import("$lib/components/agent/AgentPanel.svelte")}
          name="AI agent"
        />
      {/if}

      <!-- Status Bar -->
      <StatusBar />
    </div>

    {#each extensions.mountsFor("app-overlay") as mount (mount.id)}
      <mount.component />
    {/each}
    </div>
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

{#if dialogStore.quickEditOpen && dialogStore.quickEditResource}
  <QuickEditDialog
    bind:open={
      () => dialogStore.quickEditOpen,
      (v) => { if (!v) dialogStore.closeQuickEdit(); }
    }
    resource={dialogStore.quickEditResource}
  />
{/if}

<!-- Always mounted: a Mutation Approval can arrive with no other dialog open. -->
<AgentApprovalDialog />

{#if dialogStore.drainOpen && dialogStore.drainNodeName}
  <DrainDialog bind:open={dialogStore.drainOpen} nodeName={dialogStore.drainNodeName} />
{/if}

{#if dialogStore.compareOpen && dialogStore.compareResource}
  <!-- Function binding: closing must go through closeCompare() so the stored
       resource is cleared along with the open flag. -->
  <CompareDialog
    bind:open={
      () => dialogStore.compareOpen,
      (v) => { if (!v) dialogStore.closeCompare(); }
    }
    resource={dialogStore.compareResource}
  />
{/if}

<WorkloadConfirmDialogs />

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
      <Spinner size="md" />
      <div class="flex flex-col">
        <span class="text-[13px] font-medium text-[var(--text-primary)]">Switching context...</span>
        {#if k8sStore.switchingContextTo}
          <span class="font-mono text-[11px] text-[var(--text-secondary)]">{k8sStore.switchingContextTo}</span>
        {/if}
      </div>
    </div>
  </div>
{/if}
