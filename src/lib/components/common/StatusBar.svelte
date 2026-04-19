<script lang="ts">
  import { cn } from "$lib/utils";
  import { Loader2 } from "lucide-svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { extensions } from "$lib/extensions";
  import type { ActiveView } from "$lib/stores/ui.svelte";

  const statusColors: Record<string, string> = {
    connected: "bg-[var(--status-running)]",
    disconnected: "bg-[var(--text-muted)]",
    connecting: "bg-[var(--status-pending)] animate-pulse",
    error: "bg-[var(--status-failed)]",
  };

  let statusColor = $derived(statusColors[k8sStore.connectionStatus] ?? "bg-[var(--text-muted)]");

  interface LocalKbdHint {
    key: string;
    label: string;
  }

  function getHints(view: ActiveView, hasSelection: boolean): LocalKbdHint[] {
    const globalHints: LocalKbdHint[] = extensions.kbdHints.map((h) => ({ key: h.key, label: h.label }));

    if (view === "logs" || view === "terminal") {
      return [{ key: "Esc", label: "Back" }, ...globalHints];
    }
    if (view === "details") {
      const resource = k8sStore.selectedResource;
      if (resource) {
        const kind = resource.kind.toLowerCase();
        if (kind === "pod") {
          return [
            { key: "l", label: "Logs" },
            { key: "t", label: "Terminal" },
            { key: "e", label: "Edit YAML" },
            { key: "d", label: "Delete" },
            { key: "Esc", label: "Back" },
            ...globalHints,
          ];
        }
        if (kind === "deployment") {
          return [
            { key: "l", label: "Logs" },
            { key: "e", label: "Edit YAML" },
            { key: "d", label: "Delete" },
            { key: "Esc", label: "Back" },
            ...globalHints,
          ];
        }
      }
      return [
        { key: "e", label: "Edit YAML" },
        { key: "d", label: "Delete" },
        { key: "Esc", label: "Back" },
        ...globalHints,
      ];
    }
    // Table view
    return [
      { key: "\u2318K", label: "Command Palette" },
      { key: "j/k", label: "Navigate" },
      { key: "\u23CE", label: "Open" },
      { key: "/", label: "Filter" },
      { key: "r", label: "Refresh" },
      ...globalHints,
    ];
  }

  let hints = $derived(getHints(uiStore.activeView, uiStore.selectedRowIndex >= 0));
</script>

<footer
  class="flex h-[30px] shrink-0 items-center justify-between border-t border-[var(--border-color)] bg-[var(--bg-primary)] px-4 text-[10px] text-[var(--text-muted)]"
>
  <!-- Left: Connection + Context + Namespace + Resource Count -->
  <div class="flex items-center gap-3">
    <!-- Connection Status -->
    <div class="flex items-center gap-1.5">
      <span class={cn("h-[7px] w-[7px] rounded-full", statusColor)}></span>
      <span class="font-medium text-[var(--text-secondary)]">{k8sStore.currentContext || "Disconnected"}</span>
    </div>

    <span class="h-3 w-px bg-[var(--border-color)]"></span>

    <!-- Namespace -->
    <span>{k8sStore.currentNamespace || "All Namespaces"}</span>

    <span class="h-3 w-px bg-[var(--border-color)]"></span>

    <!-- Resource count -->
    <div class="flex items-center gap-1">
      <span>{k8sStore.selectedResourceType.charAt(0).toUpperCase() + k8sStore.selectedResourceType.slice(1)}</span>
      <span class="text-[var(--text-secondary)]">{k8sStore.resources.items.length}</span>
    </div>

    {#if k8sStore.isLoading}
      <span class="h-3 w-px bg-[var(--border-color)]"></span>
      <Loader2 class="h-3 w-3 animate-spin" />
    {/if}

    {#each extensions.mountsFor("status-bar-start") as mount (mount.id)}
      <mount.component />
    {/each}
  </div>

  <!-- Right: Keyboard Hints -->
  <div class="flex items-center gap-2.5">
    {#each hints as hint}
      <div class="flex items-center gap-1">
        <kbd
          class="inline-flex items-center rounded border border-[var(--border-color)] bg-[var(--bg-primary)] px-1 py-px text-[10px] font-medium text-[var(--text-secondary)]"
        >
          {hint.key}
        </kbd>
        <span class="text-[var(--text-muted)]">{hint.label}</span>
      </div>
    {/each}
  </div>
</footer>
