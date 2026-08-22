<script lang="ts">
  import { Button } from "$lib/components/ui";
  import { ScrollArea } from "$lib/components/ui/scroll-area";
    import { extensions } from "$lib/extensions";
  import { TABS, type TabId } from "./settings-constants";
  import GeneralTab from "./GeneralTab.svelte";
  import KubernetesTab from "./KubernetesTab.svelte";
  import ShortcutsTab from "./ShortcutsTab.svelte";
  import ExtensionsTab from "./ExtensionsTab.svelte";

  let activeTab = $state<TabId>("general");

  let allTabs = $derived([
    ...TABS,
    ...extensions.tabs.map((t) => ({ id: t.id, label: t.label, icon: t.icon })),
  ]);

  let activeExtensionTab = $derived(extensions.tabs.find((t) => t.id === activeTab));

</script>

<div class="flex h-full flex-col">
  <!-- Header -->
  <div class="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--border-color)] px-4">
    <h1 class="text-[13px] font-medium text-[var(--text-primary)]">Settings</h1>
  </div>

  <!-- Tabs -->
  <div class="flex shrink-0 gap-1 border-b border-[var(--border-color)] px-4 pt-1">
    {#each allTabs as tab (tab.id)}
      {@const isActive = activeTab === tab.id}
      <Button
        variant="tab"
        size="xs"
        class="h-auto px-3 py-2"
        active={isActive}
        activeStyle="underline"
        onclick={() => { activeTab = tab.id; }}
      >
        {#if tab.icon}
          <tab.icon class="h-3.5 w-3.5" />
        {/if}
        {tab.label}
      </Button>
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
      {:else if activeTab === "extensions"}
        <ExtensionsTab />
      {:else if activeExtensionTab}
        <activeExtensionTab.component />
      {/if}
    </div>
  </ScrollArea>
</div>
