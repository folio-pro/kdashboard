<script lang="ts">
  import { cn } from "$lib/utils";
  import { uiStore, RESOURCE_TAB_TYPES, VIEW_LABELS, type Tab } from "$lib/stores/ui.svelte";
  import {
    Activity, Box, Layers, FileText, Terminal, Unplug, Settings,
    ScrollText, Network as TopologyIcon, DollarSign, Shield, Globe, X,
    Pencil, Database,
  } from "lucide-svelte";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const iconMap: Record<string, any> = {
    overview: Activity,
    table: Box,
    details: FileText,
    logs: ScrollText,
    terminal: Terminal,
    yaml: Pencil,
    portforwards: Unplug,
    settings: Settings,
    audit: ScrollText,
    topology: TopologyIcon,
    cost: DollarSign,
    security: Shield,
    "crd-table": Database,
    login: Globe,
  };

  function getIcon(tab: Tab) {
    return iconMap[tab.type] ?? Box;
  }

  function handleMiddleClick(e: MouseEvent, tab: Tab) {
    if (e.button === 1 && tab.closable) {
      e.preventDefault();
      uiStore.closeTab(tab.id);
    }
  }

  // Context menu state
  let ctxMenu = $state<{ x: number; y: number; tabId: string } | null>(null);

  function handleContextMenu(e: MouseEvent, tab: Tab) {
    e.preventDefault();
    ctxMenu = { x: e.clientX, y: e.clientY, tabId: tab.id };
  }

  function closeCtxMenu() {
    ctxMenu = null;
  }

  function ctxAction(fn: () => void) {
    fn();
    closeCtxMenu();
  }

  $effect(() => {
    if (!ctxMenu) return;
    const handler = () => closeCtxMenu();
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  });

  let ctxIdx = $derived.by(() => {
    const menu = ctxMenu;
    return menu ? uiStore.tabs.findIndex((t) => t.id === menu.tabId) : -1;
  });
  let ctxTabObj = $derived(ctxIdx >= 0 ? uiStore.tabs[ctxIdx] : undefined);
</script>

{#if uiStore.tabs.length > 1 || (uiStore.tabs.length === 1 && uiStore.tabs[0].type !== "overview")}
  <div
    class="flex h-[34px] shrink-0 items-stretch gap-0 overflow-x-auto bg-[var(--bg-primary)] px-2 pt-1"
    role="tablist"
  >
    {#each uiStore.tabs as tab (tab.id)}
      {@const isActive = uiStore.activeTabId === tab.id}
      {@const Icon = getIcon(tab)}
      <button
        role="tab"
        aria-selected={isActive}
        class={cn(
          "group relative flex max-w-[180px] min-w-[80px] items-center gap-1.5 px-3 text-[11px] transition-colors",
          isActive
            ? "rounded-t-md bg-[var(--bg-secondary)] text-[var(--text-primary)]"
            : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
        )}
        onclick={() => uiStore.activateTab(tab.id)}
        onmousedown={(e) => handleMiddleClick(e, tab)}
        oncontextmenu={(e) => handleContextMenu(e, tab)}
        title={tab.namespace ? `${tab.label} (${tab.namespace || "All"})` : tab.label}
      >
        {#if isActive}
          <span class="absolute bottom-0 left-0 right-0 h-[2px] bg-[var(--accent)]"></span>
        {/if}
        <Icon class={cn("h-3 w-3 shrink-0", isActive && "text-[var(--accent)]")} />
        {#if tab.resourceName && RESOURCE_TAB_TYPES.has(tab.type)}
          <span class="shrink-0 font-semibold">{VIEW_LABELS[tab.type]}</span>
          <span class="min-w-0 flex-1 truncate">{tab.resourceName}</span>
        {:else}
          <span class="min-w-0 flex-1 truncate">{tab.label}</span>
        {/if}
        {#if tab.count !== undefined && tab.count > 0}
          <span class="shrink-0 tabular-nums text-[10px] text-[var(--text-dimmed)]">{tab.count}</span>
        {/if}
        {#if tab.closable}
          <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
          <span
            class={cn(
              "ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded transition-all",
              isActive
                ? "opacity-50 hover:opacity-100 hover:bg-[var(--bg-tertiary)]"
                : "opacity-0 group-hover:opacity-50 hover:opacity-100 hover:bg-[var(--bg-tertiary)]"
            )}
            role="button"
            tabindex="-1"
            onclick={(e) => { e.stopPropagation(); uiStore.closeTab(tab.id); }}
            title="Close tab"
          >
            <X class="h-3 w-3" />
          </span>
        {/if}
      </button>
    {/each}
  </div>
  <div class="h-px bg-[var(--border-color)]"></div>
{/if}

<!-- Tab context menu -->
{#if ctxMenu}
  <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
  <div
    class="fixed z-50 min-w-[180px] rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] py-1 shadow-lg"
    style="left: {ctxMenu.x}px; top: {ctxMenu.y}px;"
    onclick={(e) => e.stopPropagation()}
  >
    {#if ctxTabObj?.closable}
      <button class="ctx-item" onclick={() => ctxAction(() => uiStore.closeTab(ctxMenu!.tabId))}>
        Close
      </button>
    {/if}
    <button class="ctx-item" onclick={() => ctxAction(() => uiStore.closeOtherTabs(ctxMenu!.tabId))}>
      Close Others
    </button>
    <button
      class="ctx-item"
      disabled={ctxIdx <= 0 || !uiStore.tabs.slice(0, ctxIdx).some(t => t.closable)}
      onclick={() => ctxAction(() => uiStore.closeTabsToTheLeft(ctxMenu!.tabId))}
    >
      Close to the Left
    </button>
    <button
      class="ctx-item"
      disabled={ctxIdx >= uiStore.tabs.length - 1 || !uiStore.tabs.slice(ctxIdx + 1).some(t => t.closable)}
      onclick={() => ctxAction(() => uiStore.closeTabsToTheRight(ctxMenu!.tabId))}
    >
      Close to the Right
    </button>
    <button class="ctx-item" onclick={() => ctxAction(() => uiStore.closeAllTabs())}>
      Close All
    </button>
    <div class="my-1 h-px bg-[var(--border-color)]"></div>
    <button
      class="ctx-item"
      disabled={ctxIdx <= 0}
      onclick={() => ctxAction(() => uiStore.moveTab(ctxMenu!.tabId, "left"))}
    >
      Move Left
    </button>
    <button
      class="ctx-item"
      disabled={ctxIdx >= uiStore.tabs.length - 1}
      onclick={() => ctxAction(() => uiStore.moveTab(ctxMenu!.tabId, "right"))}
    >
      Move Right
    </button>
  </div>
{/if}

<style>
  .ctx-item {
    display: block;
    width: 100%;
    padding: 4px 12px;
    text-align: left;
    font-size: 11px;
    color: var(--text-primary);
    background: none;
    border: none;
    cursor: pointer;
    transition: background-color 0.1s;
  }
  .ctx-item:hover:not(:disabled) {
    background-color: var(--bg-tertiary);
  }
  .ctx-item:disabled {
    color: var(--text-dimmed);
    cursor: default;
  }
</style>
