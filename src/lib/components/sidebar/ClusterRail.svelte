<script lang="ts">
  import { cn } from "$lib/utils";
  import { Button } from "$lib/components/ui";
  import { ChevronLeft, Settings, AlertTriangle, RefreshCw } from "lucide-svelte";
  import { Tooltip, TooltipTrigger, TooltipContent } from "$lib/components/ui/tooltip";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { settingsStore } from "$lib/stores/settings.svelte";
  import { extensions } from "$lib/extensions";
  import { getIconById } from "$lib/utils/context-icons";
  import { getContextColor } from "$lib/utils/context-colors";
  import { contextInitials } from "$lib/utils/context-initials";
  import DeviconIcon from "$lib/components/common/DeviconIcon.svelte";
  import { switchContext } from "$lib/actions/navigation";

  async function retryLoadContexts() {
    await k8sStore.loadContexts();
  }
</script>

<!-- Rail sits a shade below the sidebar. The background derives a subtle darken
     from the active theme's own --sidebar-bg so the separation holds across every
     theme without a per-theme token. A theme may still set --rail-bg to override. -->
<div
  class="flex h-full w-[56px] shrink-0 flex-col items-center border-r border-[var(--border-color)]"
  style="background: var(--rail-bg, color-mix(in srgb, var(--sidebar-bg) 92%, #000));"
>
  <!-- Collapse button -->
  <Button
    variant="muted"
    size="icon-sm"
    class="mt-2 mb-1 rounded-full hover:bg-[var(--sidebar-hover)]"
    onclick={() => uiStore.toggleSidebar()}
    title="Collapse sidebar"
  >
    <ChevronLeft class="h-4 w-4" />
  </Button>

  <!-- Context icons -->
  <div class="flex w-full flex-1 flex-col items-center gap-[9px] overflow-y-auto overflow-x-hidden py-2">
    {#if k8sStore.contextsLoadError}
      <Tooltip>
        <TooltipTrigger>
          <div class="flex h-[34px] w-[34px] items-center justify-center rounded-lg bg-[var(--status-failed)]/15 text-[var(--status-failed)]">
            <AlertTriangle class="h-4 w-4" />
          </div>
        </TooltipTrigger>
        <TooltipContent side="right">
          <p>{k8sStore.contextsLoadError}</p>
        </TooltipContent>
      </Tooltip>
      <Button
        variant="toolbar"
        size="icon-sm"
        onclick={retryLoadContexts}
        title="Retry loading contexts"
        aria-label="Retry loading contexts"
      >
        <RefreshCw class="h-3.5 w-3.5" />
      </Button>
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
            class="relative flex h-[34px] w-[34px] shrink-0 items-center justify-center transition-[border-radius,transform] {isActive ? 'rounded-lg' : 'rounded-lg hover:rounded-lg'}"
            style={isActive
              ? `background-color: var(${color}); color: white; box-shadow: 0 0 0 2px var(--rail-bg, color-mix(in srgb, var(--sidebar-bg) 92%, #000)), 0 0 0 3.5px rgba(255,255,255,0.22);`
              : `background-color: color-mix(in srgb, var(${color}) 20%, transparent); color: var(${color});`}
            onclick={() => switchContext(ctx)}
            title={ctx}
            aria-label="Switch to context {ctx}"
            aria-current={isActive ? "true" : undefined}
          >
            {#if isActive}
              <span class="absolute top-1/2 -left-[11px] h-5 w-[3px] -translate-y-1/2 rounded-r-[3px] bg-[var(--accent)]"></span>
            {/if}
            {#if isActive && !k8sStore.reachable}
              <!-- Outage marker on the active cluster: the rail is the one
                   piece of chrome that stays visible with the sidebar open. -->
              <span
                class="absolute -right-[3px] -bottom-[3px] h-[9px] w-[9px] rounded-full bg-[var(--status-failed)]"
                style="box-shadow: 0 0 0 2px var(--rail-bg, color-mix(in srgb, var(--sidebar-bg) 92%, #000));"
                aria-hidden="true"
              ></span>
            {/if}
            {#if iconDef}
              <!--
                There used to be an icon+label combo that rendered its label at
                7px — below the size at which type is readable at all. The
                tooltip already carries the full context name, so when a custom
                icon is set the icon alone says as much.
              -->
              <DeviconIcon id={iconDef.id} class="h-5.5 w-5.5" />
            {:else if label}
              <span class="text-[10px] font-bold leading-none tracking-tight">{label}</span>
            {:else}
              <!-- Segment initials, not charAt(0): a real kubeconfig turned
                   the whole rail into a column of near-identical letters. -->
              <span class="text-[11px] font-bold tracking-tight">{contextInitials(ctx)}</span>
            {/if}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          <p>{ctx}{isActive ? " (active)" : ""}</p>
          {#if isActive && !k8sStore.reachable}
            <p class="text-[var(--status-failed)]">{k8sStore.unreachableTooltip}</p>
          {/if}
        </TooltipContent>
      </Tooltip>
    {/each}
  </div>

  <!-- Spacer + pro-injected account controls + Settings -->
  {#each extensions.mountsFor("cluster-rail-bottom") as mount (mount.id)}
    <mount.component />
  {/each}
  <!-- Full-bleed rail footer — see the note on the sidebar's expand control:
       layout-shaped chrome stays a raw button on tokens. -->
  <button
    class="flex w-full items-center justify-center border-t border-[var(--border-color)] py-3 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
    onclick={() => uiStore.toggleSettings()}
    title="Settings"
  >
    <Settings class="h-[18px] w-[18px]" />
  </button>
</div>
