<script lang="ts">
  import { cn } from "$lib/utils";
  import { ChevronLeft, Settings, AlertTriangle, RefreshCw } from "lucide-svelte";
  import { Tooltip, TooltipTrigger, TooltipContent } from "$lib/components/ui/tooltip";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { settingsStore } from "$lib/stores/settings.svelte";
  import { extensions } from "$lib/extensions";
  import { getIconById } from "$lib/utils/context-icons";
  import { getContextColor } from "$lib/utils/context-colors";
  import DeviconIcon from "$lib/components/common/DeviconIcon.svelte";

  async function retryLoadContexts() {
    await k8sStore.loadContexts();
  }

  async function switchContext(ctx: string) {
    uiStore.resetForContextChange();
    await extensions.emit({ type: "context-changed", contextName: ctx });
    await k8sStore.switchContext(ctx);
  }
</script>

<!-- Rail sits a shade below the sidebar. kdashboard sets --rail-bg explicitly;
     every other theme derives a subtle darken from its own --sidebar-bg so the
     separation holds without a per-theme token. -->
<div
  class="flex h-full w-[56px] shrink-0 flex-col items-center border-r border-[var(--border-color)]"
  style="background: var(--rail-bg, color-mix(in srgb, var(--sidebar-bg) 92%, #000));"
>
  <!-- Collapse button -->
  <button
    class={cn(
      "mt-2 mb-1 flex h-7 w-7 items-center justify-center rounded-full",
      "text-[var(--text-muted)] transition-colors hover:bg-[var(--sidebar-hover)] hover:text-[var(--text-primary)]"
    )}
    onclick={() => uiStore.toggleSidebar()}
    title="Collapse sidebar"
  >
    <ChevronLeft class="h-4 w-4" />
  </button>

  <!-- Context icons -->
  <div class="flex w-full flex-1 flex-col items-center gap-[9px] overflow-y-auto overflow-x-hidden py-2">
    {#if k8sStore.contextsLoadError}
      <Tooltip>
        <TooltipTrigger>
          <div class="flex h-[34px] w-[34px] items-center justify-center rounded-[10px] bg-[var(--status-failed)]/15 text-[var(--status-failed)]">
            <AlertTriangle class="h-4 w-4" />
          </div>
        </TooltipTrigger>
        <TooltipContent side="right">
          <p>{k8sStore.contextsLoadError}</p>
        </TooltipContent>
      </Tooltip>
      <button
        class="flex h-7 w-7 items-center justify-center rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
        onclick={retryLoadContexts}
        title="Retry loading contexts"
      >
        <RefreshCw class="h-3.5 w-3.5" />
      </button>
    {/if}
    {#each k8sStore.contexts as ctx}
      {@const custom = settingsStore.getContextCustomization(ctx)}
      {@const color = custom?.color || getContextColor(ctx)}
      {@const iconDef = custom?.icon ? getIconById(custom.icon) : undefined}
      {@const label = custom?.label}
      {@const isActive = ctx === k8sStore.currentContext}
      <Tooltip>
        <TooltipTrigger>
          <button
            class="relative flex h-[34px] w-[34px] shrink-0 items-center justify-center transition-[border-radius,transform] {isActive ? 'rounded-[8px]' : 'rounded-[10px] hover:rounded-[8px]'}"
            style={isActive
              ? `background-color: var(${color}); color: white; box-shadow: 0 0 0 2px var(--rail-bg, color-mix(in srgb, var(--sidebar-bg) 92%, #000)), 0 0 0 3.5px rgba(255,255,255,0.22);`
              : `background-color: color-mix(in srgb, var(${color}) 20%, transparent); color: var(${color});`}
            onclick={() => switchContext(ctx)}
            title={ctx}
          >
            {#if isActive}
              <span class="absolute top-1/2 -left-[11px] h-5 w-[3px] -translate-y-1/2 rounded-r-[3px] bg-[var(--accent)]"></span>
            {/if}
            {#if iconDef && label}
              <!-- Icon + label combo -->
              <div class="flex flex-col items-center gap-0.5">
                <DeviconIcon id={iconDef.id} class="h-4 w-4" />
                <span class="text-[7px] font-bold leading-none tracking-tight">{label}</span>
              </div>
            {:else if iconDef}
              <DeviconIcon id={iconDef.id} class="h-5.5 w-5.5" />
            {:else if label}
              <span class="text-[10px] font-bold leading-none tracking-tight">{label}</span>
            {:else}
              <span class="text-sm font-bold">{ctx.charAt(0).toUpperCase()}</span>
            {/if}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          <p>{ctx}{isActive ? " (active)" : ""}</p>
        </TooltipContent>
      </Tooltip>
    {/each}
  </div>

  <!-- Spacer + pro-injected account controls + Settings -->
  {#each extensions.mountsFor("cluster-rail-bottom") as mount (mount.id)}
    <mount.component />
  {/each}
  <button
    class={cn(
      "flex w-full items-center justify-center border-t border-[var(--border-color)] py-3",
      "text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
    )}
    onclick={() => uiStore.toggleSettings()}
    title="Settings"
  >
    <Settings class="h-[18px] w-[18px]" />
  </button>
</div>
