<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { Clock, AlertTriangle, CheckCircle, ChevronDown, ChevronUp } from "lucide-svelte";
  import type { Resource, Event, TimelineEntry } from "$lib/types";
  import { formatRelativeTime } from "$lib/utils/age";

  interface Props {
    resource: Resource;
  }

  let { resource }: Props = $props();

  let entries = $state<TimelineEntry[]>([]);
  let isLoading = $state(false);
  let loaded = $state(false);
  let expanded = $state(true);
  let showAll = $state(false);

  async function loadTimeline() {
    if (loaded) return;
    isLoading = true;

    const timelineEntries: TimelineEntry[] = [];

    try {
      const resourceType = resource.kind.toLowerCase() + "s";
      const events = await invoke<Event[]>("get_resource_events", {
        resourceType,
        name: resource.metadata.name,
        namespace: resource.metadata.namespace ?? "",
      });

      for (const event of events) {
        const timestamp = event.last_timestamp || event.first_timestamp || "";
        timelineEntries.push({
          timestamp,
          type: "event",
          severity: event.type === "Warning" ? "warning" : "normal",
          title: event.reason || "Event",
          detail: `${event.message || ""}${event.count && event.count > 1 ? ` (×${event.count})` : ""}`,
        });
      }
    } catch {
      // Events may not be available
    }

    const conditions = (resource.status?.conditions as Array<{
      type: string;
      status: string;
      lastTransitionTime?: string;
      reason?: string;
      message?: string;
    }>) ?? [];

    for (const cond of conditions) {
      if (cond.lastTransitionTime) {
        const isBad = cond.status === "False" && ["Available", "Ready", "PodScheduled"].includes(cond.type);
        timelineEntries.push({
          timestamp: cond.lastTransitionTime,
          type: "condition",
          severity: isBad ? "error" : "normal",
          title: `${cond.type}: ${cond.status}`,
          detail: `${cond.reason ? cond.reason + ". " : ""}${cond.message || ""}`,
        });
      }
    }

    timelineEntries.sort((a, b) => {
      if (!a.timestamp) return 1;
      if (!b.timestamp) return -1;
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });

    entries = timelineEntries;
    isLoading = false;
    loaded = true;
  }

  onMount(() => {
    loadTimeline();
  });

  function toggle() {
    expanded = !expanded;
    if (expanded) loadTimeline();
  }

  let displayEntries = $derived(
    showAll ? entries : entries.slice(0, 10)
  );

  const SEVERITY_ICONS = {
    normal: { color: "var(--status-running)" },
    warning: { color: "var(--status-pending)" },
    error: { color: "var(--status-failed)" },
  };
</script>

<div class="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
  <button
    class="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-[var(--bg-tertiary)]/50"
    onclick={toggle}
  >
    <div class="flex items-center gap-2">
      <Clock class="h-4 w-4 text-[var(--text-muted)]" />
      <span class="text-xs font-semibold text-[var(--text-primary)]">Activity</span>
      {#if entries.length > 0}
        <span class="rounded-full bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
          {entries.length}
        </span>
      {/if}
    </div>
    {#if expanded}
      <ChevronUp class="h-3.5 w-3.5 text-[var(--text-muted)]" />
    {:else}
      <ChevronDown class="h-3.5 w-3.5 text-[var(--text-muted)]" />
    {/if}
  </button>

  {#if expanded}
    <div class="border-t border-[var(--border-color)] px-4 py-3">
      {#if isLoading}
        <div class="py-4 text-center text-xs text-[var(--text-muted)]">Loading timeline...</div>
      {:else if entries.length === 0}
        <div class="py-4 text-center text-xs text-[var(--text-muted)]">No events or status changes found</div>
      {:else}
        <div class="relative flex flex-col">
          <div class="absolute bottom-0 left-[7px] top-0 w-px bg-[var(--border-color)]"></div>

          {#each displayEntries as entry, i}
            {@const config = SEVERITY_ICONS[entry.severity] ?? SEVERITY_ICONS.normal}
            <div class="relative flex gap-3 pb-3 {i === displayEntries.length - 1 ? 'pb-0' : ''}">
              <div class="relative z-10 mt-0.5 flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full bg-[var(--bg-secondary)]">
                <div
                  class="h-2 w-2 rounded-full"
                  style="background-color: {config.color};"
                ></div>
              </div>

              <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                <div class="flex items-center gap-2">
                  <span class="text-[11px] font-medium text-[var(--text-primary)]">{entry.title}</span>
                  <span class="rounded bg-[var(--bg-tertiary)] px-1 py-px text-[9px] text-[var(--text-muted)]">
                    {entry.type}
                  </span>
                </div>
                {#if entry.detail}
                  <span class="text-[11px] leading-tight text-[var(--text-secondary)]">{entry.detail}</span>
                {/if}
                <span class="text-[10px] text-[var(--text-muted)]">{formatRelativeTime(entry.timestamp)}</span>
              </div>
            </div>
          {/each}
        </div>

        {#if entries.length > 10 && !showAll}
          <button
            class="mt-2 w-full text-center text-[11px] text-[var(--accent)] hover:underline"
            onclick={() => showAll = true}
          >
            Show all {entries.length} entries
          </button>
        {/if}
      {/if}
    </div>
  {/if}
</div>
