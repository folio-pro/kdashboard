<script lang="ts">
  import { Bell, Bot } from "lucide-svelte";
  import { Badge, Button, toneStyle } from "$lib/components/ui";
  import { Popover, PopoverTrigger, PopoverContent } from "$lib/components/ui/popover";
  import { cn } from "$lib/utils";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { alertStore } from "$lib/stores/alerts.svelte";
  import { describeWatched, type Alert } from "$lib/stores/alerts.logic";
  import { agentStore } from "$lib/stores/agent.svelte";
  import { buildAlertPrompt } from "$lib/components/agent/prompts";

  function investigate(a: Alert): void {
    const watched = alertStore.watched.find((w) => w.id === a.watchedId);
    if (!watched) return;
    void agentStore.quickAction(buildAlertPrompt({ context: k8sStore.currentContext }, watched, a));
  }

  /** The status-bar bell: watched resources of this context and the recent alerts. */
</script>

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
      <Badge appearance="solid" tone="warning" size="xs">{alertStore.unread}</Badge>
    {/if}
  </PopoverTrigger>
  <PopoverContent align="start" side="top" class="w-[360px] p-0 text-[11px]" data-testid="alerts-popover">
    <div class="border-b border-[var(--border-color)] px-3 py-2 font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">Watching · {k8sStore.currentContext}</div>
    <ul class="max-h-[160px] overflow-y-auto py-1">
      {#each alertStore.watched as w (w.id)}
        <li class="flex items-center gap-2 px-3 py-1">
          <span class="min-w-0 flex-1 truncate font-mono text-[var(--text-primary)]">{describeWatched(w)}</span>
          <Button variant="ghost-tone" tone="error" size="inline-xs" onclick={() => alertStore.unwatchById(w.id)} title="Stop watching">unwatch</Button>
        </li>
      {/each}
    </ul>
    <div class="border-t border-[var(--border-color)] px-3 py-2 font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">Recent alerts</div>
    {#if alertStore.recent.length === 0}
      <div class="px-3 pb-2 text-[var(--text-muted)]">Nothing yet — checks every 20 s.</div>
    {:else}
      <ul class="max-h-[200px] overflow-y-auto py-1">
        {#each alertStore.recent as a (a.at + a.title)}
          <li class="flex items-start gap-2 px-3 py-1">
            <div class="min-w-0 flex-1">
              <div class="truncate font-medium text-[var(--tone)]" style={toneStyle(a.level === "error" ? "error" : a.level === "warning" ? "warning" : "neutral")} title={a.title}>{a.title}</div>
              <div class="truncate text-[var(--text-muted)]" title={a.body}>{a.body}</div>
            </div>
            {#if alertStore.watched.some((w) => w.id === a.watchedId)}
              <Button variant="ghost-tone" tone="neutral" size="inline-xs" title="Investigate with the AI agent" onclick={() => investigate(a)}>
                <Bot class="h-3 w-3" />
              </Button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </PopoverContent>
</Popover>
