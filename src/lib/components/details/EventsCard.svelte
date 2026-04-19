<script lang="ts">
  import { Check, AlertTriangle } from "lucide-svelte";
  import type { Resource, Event as K8sEvent } from "$lib/types";
  import { invoke } from "@tauri-apps/api/core";
  import { formatAge } from "$lib/utils/age";
  import { kindToResourceType } from "$lib/utils";

  interface Props {
    resource: Resource;
  }

  let { resource }: Props = $props();

  let events = $state<K8sEvent[]>([]);
  let eventsLoading = $state(false);

  let eventKey = $derived(`${resource.kind}:${resource.metadata.name}:${resource.metadata.namespace}`);

  $effect(() => {
    const key = eventKey;
    let cancelled = false;

    eventsLoading = true;
    invoke<K8sEvent[]>("get_resource_events", {
      resourceType: kindToResourceType(resource.kind),
      name: resource.metadata.name,
      namespace: resource.metadata.namespace ?? "",
    }).then((result) => {
      if (!cancelled) {
        events = result;
      }
    }).catch(() => {
      if (!cancelled) {
        events = [];
      }
    }).finally(() => {
      if (!cancelled) {
        eventsLoading = false;
      }
    });

    return () => { cancelled = true; };
  });

  function getEventAge(event: K8sEvent): string {
    const ts = event.last_timestamp ?? event.first_timestamp;
    if (!ts) return "";
    const age = formatAge(ts);
    return age ? `${age} ago` : "";
  }
</script>

<div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
  <div class="flex items-center justify-between px-5 py-4">
    <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">Events</h3>
    <span class="text-xs text-[var(--text-muted)]">{events.length} events</span>
  </div>

  {#if eventsLoading}
    <div class="border-t border-[var(--border-hover)] px-5 py-3.5">
      <p class="text-xs text-[var(--text-muted)]">Loading events...</p>
    </div>
  {:else if events.length === 0}
    <div class="border-t border-[var(--border-hover)] px-5 py-3.5">
      <p class="text-xs text-[var(--text-muted)]">No events found</p>
    </div>
  {:else}
    {#each events as event}
      <div class="flex gap-3.5 border-t border-[var(--border-hover)] px-5 py-3.5">
        {#if event.type === "Warning"}
          <div class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--status-failed)]/10">
            <AlertTriangle class="h-3.5 w-3.5 text-[var(--status-failed)]" />
          </div>
        {:else}
          <div class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--status-running)]/10">
            <Check class="h-3.5 w-3.5 text-[var(--status-running)]" />
          </div>
        {/if}
        <div class="flex min-w-0 flex-col gap-0.5">
          <span class="text-[13px] font-semibold text-[var(--text-primary)]">{event.reason}</span>
          <span class="text-xs text-[var(--text-muted)]">{event.message}</span>
          <span class="text-[11px] text-[var(--text-dimmed)]">{getEventAge(event)}</span>
        </div>
      </div>
    {/each}
  {/if}
</div>
