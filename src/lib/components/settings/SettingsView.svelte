<script lang="ts">
  import { cn } from "$lib/utils";
  import { ScrollArea } from "$lib/components/ui/scroll-area";
  import { ArrowLeft } from "lucide-svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { extensions } from "$lib/extensions";
  import { TABS, type TabId } from "./settings-constants";
  import GeneralTab from "./GeneralTab.svelte";
  import KubernetesTab from "./KubernetesTab.svelte";
  import ShortcutsTab from "./ShortcutsTab.svelte";

  let activeTab = $state<TabId>("general");

  let allTabs = $derived([
    ...TABS,
    ...extensions.tabs.map((t) => ({ id: t.id, label: t.label, icon: t.icon })),
  ]);

  let activeExtensionTab = $derived(extensions.tabs.find((t) => t.id === activeTab));

  function goBack() {
    uiStore.backToPrevious();
  }
</script>

<div class="flex h-full flex-col">
  <!-- Header -->
  <div class="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--border-color)] px-4">
    <button
      class="flex h-8 w-8 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
      onclick={goBack}
      aria-label="Go back"
    >
      <ArrowLeft class="h-4 w-4" />
    </button>
    <h1 class="text-sm font-medium text-[var(--text-primary)]">Settings</h1>
  </div>

  <!-- Tabs -->
  <div class="flex shrink-0 gap-1 border-b border-[var(--border-color)] px-4 pt-1">
    {#each allTabs as tab (tab.id)}
      {@const isActive = activeTab === tab.id}
      <button
        class={cn(
          "flex items-center gap-1.5 border-b-2 px-3 py-2 text-[11px] font-medium transition-colors",
          isActive
            ? "border-[var(--accent)] text-[var(--text-primary)]"
            : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
        )}
        onclick={() => { activeTab = tab.id; }}
      >
        {#if tab.icon}
          <tab.icon class="h-3.5 w-3.5" />
        {/if}
        {tab.label}
      </button>
    {/each}
  </div>

  <!-- Content -->
  <ScrollArea class="flex-1">
    <div class="mx-auto max-w-2xl space-y-10 px-6 py-6">
      {#if activeTab === "general"}
        <GeneralTab />
      {:else if activeTab === "kubernetes"}
        <KubernetesTab />
      {:else if activeTab === "shortcuts"}
        <ShortcutsTab />
      {:else if activeExtensionTab}
        <activeExtensionTab.component />
      {/if}
    </div>
  </ScrollArea>
</div>
