<script lang="ts">
  import { contextMenuStore } from "$lib/stores/context-menu.svelte";
  import {
    getActionsForResource,
    getBulkActions,
    groupActions,
  } from "$lib/actions/registry";
  import type { ActionDef, BulkActionDef, TableAction } from "$lib/actions/types";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import {
    calculateMenuPosition,
    isActionEnabled as _isActionEnabled,
    findNextEnabled as _findNextEnabled,
    tierColor,
  } from "./context-menu";

  let menuRef: HTMLDivElement | undefined = $state();
  let focusedIndex = $state(-1);

  // Guard all derivations behind open state to avoid work when menu is closed
  let singleActions = $derived.by(() => {
    if (!contextMenuStore.open) return [];
    const ctx = contextMenuStore.context;
    if (!ctx || ctx.type !== "resource" || !ctx.resource) return [];
    return getActionsForResource(ctx.resource);
  });

  let bulkActionsList = $derived.by(() => {
    if (!contextMenuStore.open) return [];
    const ctx = contextMenuStore.context;
    if (!ctx || ctx.type !== "bulk") return [];
    return getBulkActions(ctx.resourceType ?? k8sStore.selectedResourceType);
  });

  let groupedSingle = $derived(contextMenuStore.open ? groupActions(singleActions) : []);
  let groupedBulk = $derived(contextMenuStore.open ? groupActions(bulkActionsList) : []);

  let isBulk = $derived(contextMenuStore.context?.type === "bulk");
  let isTable = $derived(contextMenuStore.context?.type === "table");
  let bulkCount = $derived(contextMenuStore.context?.resources?.length ?? 0);
  let tableActions = $derived.by((): TableAction[] => {
    if (!contextMenuStore.open || !isTable) return [];
    return contextMenuStore.context?.tableActions ?? [];
  });

  // Flat list for keyboard navigation
  let flatItems = $derived.by((): Array<ActionDef | BulkActionDef | TableAction> => {
    if (!contextMenuStore.open) return [];
    if (isTable) return tableActions;
    return isBulk ? bulkActionsList : singleActions;
  });

  // Position the menu within viewport
  let menuStyle = $derived.by(() => {
    if (!contextMenuStore.open) return "display: none;";
    const groupCount = isBulk ? groupedBulk.length : groupedSingle.length;
    const pos = calculateMenuPosition(
      contextMenuStore.x,
      contextMenuStore.y,
      flatItems.length,
      groupCount,
      window.innerWidth,
      window.innerHeight,
      isBulk,
    );
    return `left: ${pos.x}px; top: ${pos.y}px;`;
  });

  function isActionEnabled(action: ActionDef): boolean {
    return _isActionEnabled(action, contextMenuStore.context?.resource ?? null);
  }

  function close() {
    contextMenuStore.close();
    focusedIndex = -1;
  }

  function executeAction(action: ActionDef | BulkActionDef | TableAction) {
    const ctx = contextMenuStore.context;
    close();
    if (!ctx) return;

    if (ctx.type === "table") {
      (action as TableAction).execute();
    } else if (ctx.type === "resource" && ctx.resource) {
      (action as ActionDef).execute(ctx.resource);
    } else if (ctx.type === "bulk" && ctx.resources) {
      (action as BulkActionDef).execute(ctx.resources);
    }
  }

  /** Find next enabled item index in given direction */
  function findNextEnabled(from: number, direction: 1 | -1): number {
    return _findNextEnabled(
      from,
      direction,
      flatItems as ActionDef[],
      isBulk,
      contextMenuStore.context?.resource ?? null,
    );
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!contextMenuStore.open) return;

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusedIndex = findNextEnabled(focusedIndex, 1);
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      focusedIndex = findNextEnabled(focusedIndex, -1);
      return;
    }

    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (focusedIndex >= 0 && focusedIndex < flatItems.length) {
        const action = flatItems[focusedIndex];
        if (isBulk || isActionEnabled(action as ActionDef)) {
          executeAction(action);
        }
      }
      return;
    }
  }

  function handleBackdropClick(e: MouseEvent) {
    if (menuRef && !menuRef.contains(e.target as Node)) {
      close();
    }
  }

  // Only listen for scroll/resize when menu is open
  $effect(() => {
    if (!contextMenuStore.open) return;
    const handleClose = () => close();
    window.addEventListener("scroll", handleClose, true);
    window.addEventListener("resize", handleClose);
    return () => {
      window.removeEventListener("scroll", handleClose, true);
      window.removeEventListener("resize", handleClose);
    };
  });

  // Focus menu when opened
  $effect(() => {
    if (contextMenuStore.open && menuRef) {
      // Find first enabled item
      if (isBulk || isTable) {
        focusedIndex = flatItems.length > 0 ? 0 : -1;
      } else {
        focusedIndex = flatItems.findIndex((a) => isActionEnabled(a as ActionDef));
      }
      menuRef.focus();
    }
  });

  // tierColor is imported from ./context-menu.ts
</script>

{#if contextMenuStore.open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-[100]"
    onmousedown={handleBackdropClick}
    oncontextmenu={(e) => { e.preventDefault(); close(); }}
  >
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      bind:this={menuRef}
      role="menu"
      tabindex="-1"
      class="context-menu fixed z-[101] min-w-[200px] max-w-[260px] overflow-hidden rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] py-1.5 shadow-xl outline-none"
      style={menuStyle}
      onkeydown={handleKeydown}
    >
      {#if isTable}
        <!-- Table-level actions -->
        {#each tableActions as action, idx}
          {@const IconComp = action.icon}
          <button
            role="menuitem"
            class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs transition-colors hover:bg-[var(--bg-tertiary)]"
            class:bg-[var(--bg-tertiary)]={focusedIndex === idx}
            onmouseenter={() => (focusedIndex = idx)}
            onclick={() => executeAction(action)}
          >
            {#if IconComp}
              <IconComp class="h-3.5 w-3.5 shrink-0 opacity-70 text-[var(--text-muted)]" />
            {/if}
            <span class="flex-1 truncate text-[var(--text-secondary)]">{action.label}</span>
          </button>
        {/each}
      {:else if isBulk}
        <!-- Bulk header -->
        <div class="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
          {bulkCount} {bulkCount === 1 ? "resource" : "resources"} selected
        </div>
        <div class="mx-2 my-1 border-t border-[var(--border-hover)]"></div>

        {#each groupedBulk as group, gi}
          {#if gi > 0}
            <div class="mx-2 my-1 border-t border-[var(--border-hover)]"></div>
          {/if}
          {#each group.actions as action}
            {@const flatIdx = bulkActionsList.indexOf(action)}
            {@const IconComp = action.icon}
            <button
              role="menuitem"
              class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs transition-colors hover:bg-[var(--bg-tertiary)]"
              class:bg-[var(--bg-tertiary)]={focusedIndex === flatIdx}
              style:color={tierColor(action.tier)}
              onmouseenter={() => (focusedIndex = flatIdx)}
              onclick={() => executeAction(action)}
            >
              {#if IconComp}
                <IconComp class="h-3.5 w-3.5 shrink-0 opacity-70" />
              {/if}
              <span class="flex-1 truncate">{action.label} ({bulkCount})</span>
            </button>
          {/each}
        {/each}
      {:else}
        <!-- Single resource actions -->
        {#each groupedSingle as group, gi}
          {#if gi > 0}
            <div class="mx-2 my-1 border-t border-[var(--border-hover)]"></div>
          {/if}
          {#each group.actions as action}
            {@const flatIdx = singleActions.indexOf(action)}
            {@const IconComp = action.icon}
            {@const isEnabled = isActionEnabled(action)}
            <button
              role="menuitem"
              class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs transition-colors"
              class:hover:bg-[var(--bg-tertiary)]={isEnabled}
              class:bg-[var(--bg-tertiary)]={focusedIndex === flatIdx && isEnabled}
              class:opacity-40={!isEnabled}
              class:cursor-not-allowed={!isEnabled}
              style:color={action.tier === "red" ? tierColor("red") : ""}
              disabled={!isEnabled}
              title={!isEnabled && action.disabledReason && contextMenuStore.context?.resource
                ? action.disabledReason(contextMenuStore.context.resource)
                : undefined}
              onmouseenter={() => { if (isEnabled) focusedIndex = flatIdx; }}
              onclick={() => { if (isEnabled) executeAction(action); }}
            >
              {#if IconComp}
                <IconComp class="h-3.5 w-3.5 shrink-0 opacity-70" />
              {/if}
              <span class="flex-1 truncate">{action.label}</span>
              {#if action.shortcut}
                <kbd class="shrink-0 rounded border border-[var(--border-color)] px-1 py-0.5 text-[9px] text-[var(--text-muted)]">
                  {action.shortcut}
                </kbd>
              {/if}
            </button>
          {/each}
        {/each}

        {#if singleActions.length === 0}
          <div class="px-3 py-2 text-xs text-[var(--text-muted)]">No actions available</div>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .context-menu {
    animation: contextMenuIn 0.1s ease-out;
  }

  @keyframes contextMenuIn {
    from {
      opacity: 0;
      transform: scale(0.95);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }
</style>
