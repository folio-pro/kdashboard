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

<div class="flex h-full w-[52px] shrink-0 flex-col items-center border-r border-[var(--border-color)] py-2">
  <!-- Collapse button -->
  <button
    class={cn(
      "mb-2 flex h-7 w-7 items-center justify-center rounded-full",
      "text-[var(--text-muted)] transition-colors hover:bg-[var(--sidebar-hover)] hover:text-[var(--text-primary)]"
    )}
    onclick={() => uiStore.toggleSidebar()}
    title="Collapse sidebar"
  >
    <ChevronLeft class="h-4 w-4" />
  </button>

  <!-- Context icons -->
  <div class="flex flex-1 flex-col items-center gap-1.5 overflow-y-auto overflow-x-hidden">
    {#if k8sStore.contextsLoadError}
      <Tooltip>
        <TooltipTrigger>
          <div class="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--status-failed)]/15 text-[var(--status-failed)]">
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
            class="relative flex h-9 w-9 items-center justify-center rounded-lg transition-colors"
            style={isActive
              ? `background-color: var(${color}); color: white;`
              : `background-color: color-mix(in srgb, var(${color}) 20%, transparent); color: var(${color});`}
            onclick={() => switchContext(ctx)}
            title={ctx}
          >
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
            {#if isActive}
              <span
                class="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--sidebar-bg)]"
                style="background-color: var({color});"
              ></span>
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
      "mt-1.5 flex h-7 w-7 items-center justify-center rounded-full border border-[var(--border-color)]",
      "text-[var(--text-muted)] transition-colors hover:bg-[var(--sidebar-hover)] hover:text-[var(--text-primary)]"
    )}
    onclick={() => uiStore.toggleSettings()}
    title="Settings"
  >
    <Settings class="h-3.5 w-3.5" />
  </button>
</div>
