<script lang="ts">
  import { Bell } from "lucide-svelte";
  import type { Resource, Event as K8sEvent } from "$lib/types";
  import { invoke } from "$lib/ipc/core";
  import { formatAge } from "$lib/utils/age";
  import { kindToResourceType } from "$lib/utils";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { Button } from "$lib/components/ui";
  import DetailSection from "./DetailSection.svelte";

  /**
   * The last few events inline on the overview, newest first, so a BackOff
   * is visible without switching to the Events subtab. "All events" opens
   * that subtab (EventsCard), which merges in the lifecycle conditions.
   */
  interface Props {
    resource: Resource;
    limit?: number;
  }

  let { resource, limit = 4 }: Props = $props();

  let events = $state<K8sEvent[]>([]);
  let loading = $state(false);

  // Primitive deriveds rather than `resource` itself: the prop is replaced on
  // every watch delta, and reading its fields in the effect would re-run the
  // fetch (and cancel the previous one) on each of them.
  let resourceType = $derived(kindToResourceType(resource.kind));
  let resourceName = $derived(resource.metadata.name);
  let resourceNamespace = $derived(resource.metadata.namespace ?? "");

  $effect(() => {
    const args = { resourceType, name: resourceName, namespace: resourceNamespace };
    let cancelled = false;
    loading = true;
    invoke<K8sEvent[]>("get_resource_events", args)
      .then((result) => {
        if (!cancelled) events = result;
      })
      .catch(() => {
        if (!cancelled) events = [];
      })
      .finally(() => {
        if (!cancelled) loading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  // Timestamps cross the IPC boundary as strings or Dates (structured clone
  // keeps a Date a Date), and classic events may carry neither.
  const ts = (e: K8sEvent): string => {
    const v: unknown = e.last_timestamp ?? e.first_timestamp;
    if (v == null) return "";
    return v instanceof Date ? v.toISOString() : String(v);
  };
  let recent = $derived([...events].sort((a, b) => ts(b).localeCompare(ts(a))).slice(0, limit));
</script>

{#if recent.length > 0 || loading}
  <DetailSection title="Recent events" icon={Bell}>
    {#snippet actions()}
      <span class="font-mono text-[11px] text-[var(--text-muted)]">{loading ? "…" : events.length}</span>
      <Button variant="muted" size="inline-xs" class="text-[var(--accent)] hover:text-[var(--accent)]" onclick={() => { uiStore.detailSubtab = "events"; }}>All events</Button>
    {/snippet}
    <div class="flex flex-col">
      {#each recent as e, i (`${e.reason}:${ts(e)}:${i}`)}
        {@const warning = e.type === "Warning"}
        <div class="flex min-h-[30px] items-center gap-3 border-b border-[var(--hairline)] last:border-b-0" title={e.message ?? ""}>
          <span class="w-9 shrink-0 font-mono text-[11px] tabular-nums text-[var(--text-muted)]">{ts(e) ? formatAge(ts(e)) : "—"}</span>
          {#if warning}
            <span
              class="inline-flex shrink-0 items-center gap-1.5 rounded-sm px-1.5 text-[11px] font-medium leading-4"
              style="color: var(--status-pending); background-color: color-mix(in srgb, var(--status-pending) 12%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--status-pending) 25%, transparent);"
            ><span class="h-[5px] w-[5px] rounded-full bg-[var(--status-pending)]"></span>Warning</span>
          {:else}
            <span class="w-[58px] shrink-0 text-[11px] text-[var(--text-muted)]">Normal</span>
          {/if}
          <span class="w-[120px] shrink-0 truncate font-mono text-[11px] text-[var(--text-secondary)]">{e.reason || "Event"}</span>
          <span class="min-w-0 flex-1 truncate text-[12px] text-[var(--text-secondary)]">{e.message ?? ""}</span>
          {#if (e.count ?? 1) > 1}
            <span class="shrink-0 font-mono text-[11px] tabular-nums text-[var(--text-muted)]">×{e.count}</span>
          {/if}
        </div>
      {/each}
    </div>
  </DetailSection>
{/if}
