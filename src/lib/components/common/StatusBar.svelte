<script lang="ts">
  import { Kbd, Spinner } from "$lib/components/ui";
  import { cn } from "$lib/utils";
  import { Unplug } from "lucide-svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { openAppView } from "$lib/actions/navigation";
  import { alertStore } from "$lib/stores/alerts.svelte";
  import AlertsPopover from "./AlertsPopover.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { extensions } from "$lib/extensions";
  import { hintsForView } from "$lib/shortcuts";

  const statusColors: Record<string, string> = {
    connected: "bg-[var(--status-running)]",
    disconnected: "bg-[var(--text-muted)]",
    connecting: "bg-[var(--status-pending)] animate-pulse",
    error: "bg-[var(--status-failed)]",
  };

  let statusColor = $derived(statusColors[k8sStore.connectionStatus] ?? "bg-[var(--text-muted)]");

  // Hints come straight from the shortcut registry, so what the bar advertises
  // is by construction what the dispatcher implements.
  let hints = $derived([
    ...hintsForView(uiStore.activeView).map((s) => ({ key: s.keys, label: s.label })),
    ...extensions.kbdHints.map((h) => ({ key: h.key, label: h.label })),
  ]);
</script>

<footer
  class="flex h-[30px] shrink-0 items-center justify-between border-t border-[var(--border-color)] bg-[var(--bg-primary)] px-4 text-[10px] text-[var(--text-muted)]"
>
  <!--
    Left: connection + port forwards only. Namespace and the resource count
    used to live here too, but both are stated by the view header a few
    hundred pixels above (and the namespace again in the sidebar) — three
    copies of the same fact, none of them the one the eye goes to.
  -->
  <div class="flex items-center gap-3">
    <!-- Connection Status -->
    <div class="flex items-center gap-1.5">
      <span class={cn("h-[7px] w-[7px] rounded-full", statusColor)}></span>
      <span class="font-medium text-[var(--text-secondary)]">{k8sStore.currentContext || "Disconnected"}</span>
    </div>

    <span class="h-3 w-px bg-[var(--border-color)]"></span>

    <!-- Port forwards: count + jump to the view -->
    <button
      class={cn(
        "flex items-center gap-1 transition-colors hover:text-[var(--text-primary)]",
        uiStore.activeView === "portforwards" && "text-[var(--accent)]",
        k8sStore.portForwards.length > 0 && uiStore.activeView !== "portforwards" && "text-[var(--text-secondary)]"
      )}
      title="Port forwards"
      onclick={() => openAppView("portforwards")}
    >
      <Unplug class="h-3 w-3" />
      <span>{k8sStore.portForwards.length}</span>
    </button>

    {#if alertStore.watched.length > 0}
      <span class="h-3 w-px bg-[var(--border-color)]"></span>
      <AlertsPopover />
    {/if}

    {#if k8sStore.isLoading}
      <span class="h-3 w-px bg-[var(--border-color)]"></span>
      <Spinner size="xs" />
    {/if}

    {#each extensions.mountsFor("status-bar-start") as mount (mount.id)}
      <mount.component />
    {/each}
  </div>

  <!-- Right: Keyboard Hints -->
  <div class="flex items-center gap-2.5">
    {#each hints as hint}
      <div class="flex items-center gap-1">
        <Kbd class="min-w-[16px] justify-center px-1 py-px font-medium">{hint.key}</Kbd>
        <span class="text-[var(--text-muted)]">{hint.label}</span>
      </div>
    {/each}
  </div>
</footer>
