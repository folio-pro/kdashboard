<script lang="ts">
  import { cn } from "$lib/utils";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { X, RefreshCw } from "lucide-svelte";
  import { settingsStore } from "$lib/stores/settings.svelte";
  import { toastStore } from "$lib/stores/toast.svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { costStore } from "$lib/stores/cost.svelte";
  import { getIconById, iconsByCategory } from "$lib/utils/context-icons";
  import { getContextColor } from "$lib/utils/context-colors";
  import DeviconIcon from "$lib/components/common/DeviconIcon.svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { COLOR_OPTIONS, ICON_CATEGORIES } from "./settings-constants";

  let kubeconfigPath = $state(settingsStore.settings.kubeconfig_path);
  let editingContext = $state<string | null>(null);
  let refreshingPricing = $state(false);
  let labelDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  function handleKubeconfigSave() {
    settingsStore.updateKubeconfigPath(kubeconfigPath);
    toastStore.success("Kubeconfig path saved");
  }

  function setContextIcon(context: string, iconId: string | undefined) {
    const current = settingsStore.getContextCustomization(context) ?? {};
    settingsStore.updateContextCustomization(context, { ...current, icon: iconId });
  }

  function setContextLabel(context: string, label: string) {
    clearTimeout(labelDebounceTimer);
    const trimmed = label.slice(0, 3);
    labelDebounceTimer = setTimeout(() => {
      const current = settingsStore.getContextCustomization(context) ?? {};
      settingsStore.updateContextCustomization(context, { ...current, label: trimmed || undefined });
    }, 300);
  }

  function setContextColor(context: string, color: string | undefined) {
    const current = settingsStore.getContextCustomization(context) ?? {};
    settingsStore.updateContextCustomization(context, { ...current, color });
  }

  function resetContext(context: string) {
    settingsStore.updateContextCustomization(context, {});
  }
</script>

<!-- Context Customization -->
<section>
  <h2 class="text-xs font-semibold uppercase tracking-wider text-[var(--text-primary)]">Contexts</h2>
  <p class="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
    Assign icons, labels, and colors to your contexts to tell them apart in the sidebar.
  </p>

  <div class="mt-4 space-y-1.5">
    {#each k8sStore.contexts as ctx}
      {@const custom = settingsStore.getContextCustomization(ctx)}
      {@const isEditing = editingContext === ctx}
      {@const isActive = ctx === k8sStore.currentContext}
      {@const hasCustom = custom?.icon || custom?.label || custom?.color}
      {@const iconDef = custom?.icon ? getIconById(custom.icon) : undefined}
      {@const badgeColor = custom?.color || getContextColor(ctx)}
      <div class={cn("rounded-lg border transition-colors", isEditing ? "border-[var(--accent)]/40" : "border-[var(--border-color)]")}>
        <!-- Context row -->
        <button
          class={cn(
            "flex w-full items-center gap-3 px-3 py-2.5 text-left text-xs transition-colors",
            isEditing ? "rounded-t-lg bg-[var(--bg-secondary)]" : "rounded-lg hover:bg-[var(--bg-secondary)]/50"
          )}
          onclick={() => { editingContext = isEditing ? null : ctx; }}
        >
          <!-- Live sidebar preview badge -->
          <span
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
            style="background-color: color-mix(in srgb, var({badgeColor}) 20%, transparent); color: var({badgeColor});"
          >
            {#if iconDef && custom?.label}
              <span class="flex flex-col items-center gap-0.5">
                <DeviconIcon id={iconDef.id} class="h-4 w-4" />
                <span class="text-[7px] font-bold leading-none tracking-tight">{custom.label}</span>
              </span>
            {:else if iconDef}
              <DeviconIcon id={iconDef.id} class="h-5.5 w-5.5" />
            {:else if custom?.label}
              <span class="text-[10px] font-bold leading-none tracking-tight">{custom.label}</span>
            {:else}
              <span class="text-sm font-bold">{ctx.charAt(0).toUpperCase()}</span>
            {/if}
          </span>
          <span class="flex-1 truncate font-medium text-[var(--text-primary)]">{ctx}</span>
          {#if isActive}
            <span class="rounded-full bg-[var(--accent)]/15 px-2 py-0.5 text-[9px] font-medium text-[var(--accent)]">active</span>
          {/if}
          {#if hasCustom}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <span
              role="button"
              tabindex="0"
              class="flex h-5 w-5 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
              onclick={(e) => { e.stopPropagation(); resetContext(ctx); }}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); resetContext(ctx); } }}
              title="Reset customization"
            >
              <X class="h-3 w-3" />
            </span>
          {/if}
        </button>

        <!-- Expanded editor -->
        {#if isEditing}
          <div class="border-t border-[var(--border-color)] px-3 py-3 space-y-4">
            <!-- Custom label -->
            <div>
              <span class="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Label (max 3 chars)</span>
              <Input
                type="text"
                placeholder="e.g. PRD, STG, DEV"
                value={custom?.label ?? ""}
                oninput={(e) => setContextLabel(ctx, (e.target as HTMLInputElement).value)}
                maxlength={3}
                class="h-8 w-40 font-mono text-xs uppercase"
              />
            </div>

            <!-- Icon picker -->
            <div>
              <span class="mb-2 block text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Icon</span>
              {#each ICON_CATEGORIES as cat}
                {@const icons = iconsByCategory[cat.key] ?? []}
                <div class="mb-2.5">
                  <span class="mb-1 block text-[9px] text-[var(--text-muted)]">{cat.label}</span>
                  <div class="flex flex-wrap gap-1">
                    {#each icons as icon}
                      {@const isSelected = custom?.icon === icon.id}
                      <button
                        class={cn(
                          "group relative flex h-8 w-8 items-center justify-center rounded-md border transition-all",
                          isSelected
                            ? "border-[var(--accent)] bg-[var(--accent)]/10"
                            : "border-transparent hover:border-[var(--border-color)] hover:bg-[var(--bg-tertiary)]"
                        )}
                        onclick={() => setContextIcon(ctx, isSelected ? undefined : icon.id)}
                        title={icon.label}
                      >
                        <DeviconIcon id={icon.id} class="h-4.5 w-4.5" />
                      </button>
                    {/each}
                  </div>
                </div>
              {/each}
            </div>

            <!-- Color picker -->
            <div>
              <span class="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Color</span>
              <div class="flex gap-1.5">
                {#each COLOR_OPTIONS as colorOpt}
                  {@const isSelected = custom?.color === colorOpt.id}
                  <button
                    class={cn(
                      "flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[10px] transition-all",
                      isSelected
                        ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text-primary)]"
                        : "border-[var(--border-color)] text-[var(--text-secondary)] hover:border-[var(--border-hover)]"
                    )}
                    onclick={() => setContextColor(ctx, isSelected ? undefined : colorOpt.id)}
                  >
                    <span
                      class="h-2.5 w-2.5 rounded-full"
                      style="background-color: var({colorOpt.id});"
                    ></span>
                    {colorOpt.label}
                  </button>
                {/each}
              </div>
            </div>
          </div>
        {/if}
      </div>
    {/each}
  </div>

  {#if k8sStore.contexts.length === 0}
    <div class="mt-3 rounded-lg border border-dashed border-[var(--border-color)] px-4 py-3 text-center">
      <p class="text-[11px] text-[var(--text-muted)]">
        No contexts found. Check your kubeconfig path below.
      </p>
    </div>
  {/if}
</section>

<!-- Kubernetes Configuration -->
<section>
  <h2 class="text-xs font-semibold uppercase tracking-wider text-[var(--text-primary)]">Kubeconfig</h2>
  <p class="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
    Path to your kubeconfig file. Leave empty to use the default location (~/.kube/config).
  </p>
  <div class="mt-4 flex gap-2">
    <Input
      type="text"
      placeholder="~/.kube/config"
      value={kubeconfigPath}
      oninput={(e) => { kubeconfigPath = (e.target as HTMLInputElement).value; }}
      class="h-9 flex-1 text-xs"
    />
    <Button
      size="sm"
      class="h-9"
      onclick={handleKubeconfigSave}
    >
      Save
    </Button>
  </div>
</section>

<!-- Cost Pricing -->
<section>
  <h2 class="text-xs font-semibold uppercase tracking-wider text-[var(--text-primary)]">Cost Pricing</h2>
  <p class="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
    Node pricing is fetched from cloud providers (AWS, Azure, GCP) and cached for 24 hours.
    Prices are updated monthly on the server. Force a refresh if you need the latest rates.
  </p>
  <div class="mt-4 flex items-center gap-3">
    <Button
      size="sm"
      variant="outline"
      class="h-9 gap-2"
      onclick={async () => {
        refreshingPricing = true;
        try {
          await invoke("refresh_pricing");
          costStore.reset();
          toastStore.success("Pricing cache cleared. Prices will refresh on next load.");
        } catch (e) {
          toastStore.error("Failed to refresh pricing: " + e);
        } finally {
          refreshingPricing = false;
        }
      }}
      disabled={refreshingPricing}
    >
      <RefreshCw class="h-3.5 w-3.5 {refreshingPricing ? 'animate-spin' : ''}" />
      Refresh Pricing
    </Button>
    <span class="text-[11px] text-[var(--text-muted)]">
      Clears local cache and re-fetches from server on next cost/node view.
    </span>
  </div>
</section>
