<script lang="ts">
  import { Kbd, Spinner } from "$lib/components/ui";
  import { cn } from "$lib/utils";
  import { Unplug, Bell } from "lucide-svelte";
  import { Popover, PopoverTrigger, PopoverContent } from "$lib/components/ui/popover";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { alertStore } from "$lib/stores/alerts.svelte";
  import { describeWatched } from "$lib/stores/alerts.logic";
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
      onclick={() => uiStore.showView("portforwards")}
    >
      <Unplug class="h-3 w-3" />
      <span>{k8sStore.portForwards.length}</span>
    </button>

    {#if alertStore.watched.length > 0}
      <span class="h-3 w-px bg-[var(--border-color)]"></span>
      <Popover onOpenChange={(open) => { if (open) alertStore.markRead(); }}>
        <PopoverTrigger
          class={cn(
            "flex items-center gap-1 transition-colors hover:text-[var(--text-primary)]",
            alertStore.unread > 0 ? "text-[var(--status-pending)]" : "text-[var(--text-secondary)]",
          )}
          title="Watched resources and recent alerts"
          data-testid="alerts-indicator"
        >
          <Bell class="h-3 w-3" />
          <span>{alertStore.watched.length}</span>
          {#if alertStore.unread > 0}
            <span class="rounded-full bg-[var(--status-pending)] px-1 text-[9px] font-semibold leading-[12px] text-[var(--bg-primary)]">{alertStore.unread}</span>
          {/if}
        </PopoverTrigger>
        <PopoverContent align="start" side="top" class="w-[360px] p-0 text-[11px]" data-testid="alerts-popover">
          <div class="border-b border-[var(--border-color)] px-3 py-2 font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">Watching · {k8sStore.currentContext}</div>
          <ul class="max-h-[160px] overflow-y-auto py-1">
            {#each alertStore.watched as w (w.id)}
              <li class="flex items-center gap-2 px-3 py-1">
                <span class="min-w-0 flex-1 truncate font-mono text-[var(--text-primary)]">{describeWatched(w)}</span>
                <button class="text-[var(--text-muted)] hover:text-[var(--status-failed)]" onclick={() => alertStore.unwatchById(w.id)} title="Stop watching">unwatch</button>
              </li>
            {/each}
          </ul>
          <div class="border-t border-[var(--border-color)] px-3 py-2 font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">Recent alerts</div>
          {#if alertStore.recent.length === 0}
            <div class="px-3 pb-2 text-[var(--text-muted)]">Nothing yet — checks every 20 s.</div>
          {:else}
            <ul class="max-h-[200px] overflow-y-auto py-1">
              {#each alertStore.recent as a (a.at + a.title)}
                <li class="px-3 py-1">
                  <div class={cn("truncate font-medium", a.level === "error" ? "text-[var(--status-failed)]" : a.level === "warning" ? "text-[var(--status-pending)]" : "text-[var(--text-primary)]")} title={a.title}>{a.title}</div>
                  <div class="truncate text-[var(--text-muted)]" title={a.body}>{a.body}</div>
                </li>
              {/each}
            </ul>
          {/if}
        </PopoverContent>
      </Popover>
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
