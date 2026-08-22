<script lang="ts">
  import { AlertTriangle } from "lucide-svelte";
  import type { Resource, Event as K8sEvent } from "$lib/types";
  import { invoke } from "$lib/ipc/core";
  import { formatAge } from "$lib/utils/age";
  import { kindToResourceType } from "$lib/utils";

  interface Props {
    resource: Resource;
  }

  let { resource }: Props = $props();

  let events = $state<K8sEvent[]>([]);
  let eventsLoading = $state(false);
  let error = $state<string | null>(null);

  // Primitive deriveds: the `resource` prop is replaced on every watch delta
  // (same pod, new object), and an effect that read its fields directly
  // re-ran each time — cancelling the in-flight fetch and never showing
  // anything for a pod that updates often. These only notify on a real change.
  let resourceType = $derived(kindToResourceType(resource.kind));
  let resourceName = $derived(resource.metadata.name);
  let resourceNamespace = $derived(resource.metadata.namespace ?? "");

  $effect(() => {
    const args = { resourceType, name: resourceName, namespace: resourceNamespace };
    let cancelled = false;

    eventsLoading = true;
    error = null;
    invoke<K8sEvent[]>("get_resource_events", args).then((result) => {
      if (!cancelled) {
        events = result;
      }
    }).catch((err) => {
      if (!cancelled) {
        events = [];
        error = String(err);
      }
    }).finally(() => {
      if (!cancelled) {
        eventsLoading = false;
      }
    });

    return () => { cancelled = true; };
  });

  interface EventRow {
    ts: string;
    warning: boolean;
    reason: string;
    message: string;
    count: number | null;
  }

  // Merge real Kubernetes events with the resource's lifecycle conditions so
  // the table stays useful after events expire (~1h) — mirroring Activity.
  let rows = $derived.by<EventRow[]>(() => {
    const out: EventRow[] = [];

    for (const e of events) {
      out.push({
        ts: e.last_timestamp ?? e.first_timestamp ?? "",
        warning: e.type === "Warning",
        reason: e.reason || "Event",
        message: e.message ?? "",
        count: e.count ?? 1,
      });
    }

    const conditions = (resource.status?.conditions as Array<{
      type: string;
      status: string;
      lastTransitionTime?: string;
      reason?: string;
      message?: string;
    }>) ?? [];
    for (const c of conditions) {
      if (!c.lastTransitionTime) continue;
      const bad = c.status === "False" &&
        ["Available", "Ready", "PodScheduled", "ContainersReady", "Initialized"].includes(c.type);
      out.push({
        ts: c.lastTransitionTime,
        warning: bad,
        reason: c.type,
        message: `${c.status}${c.reason ? " · " + c.reason : ""}${c.message ? " — " + c.message : ""}`,
        count: null,
      });
    }

    out.sort((a, b) => {
      if (!a.ts) return 1;
      if (!b.ts) return -1;
      return new Date(b.ts).getTime() - new Date(a.ts).getTime();
    });
    return out;
  });

  function lastSeen(ts: string): string {
    if (!ts) return "—";
    const age = formatAge(ts);
    return age ? `${age} ago` : "—";
  }
</script>

{#if eventsLoading && rows.length === 0}
  <p class="px-6 py-4 text-[12px] text-[var(--text-muted)]">Loading events…</p>
{:else if error && rows.length === 0}
  <div class="mx-6 my-4 flex items-start gap-2 rounded-md border border-[var(--status-failed)]/30 bg-[var(--status-failed)]/5 px-3 py-2.5">
    <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--status-failed)]" />
    <span class="text-[12px] text-[var(--status-failed)]">{error}</span>
  </div>
{:else if rows.length === 0}
  <div class="flex flex-col items-center gap-1.5 py-16 text-center">
    <div class="text-[13px] text-[var(--text-secondary)]">No events for this {resource.kind}</div>
    <p class="max-w-sm text-[11px] leading-relaxed text-[var(--text-muted)]">
      Kubernetes events expire after about an hour.{resource.kind === "Deployment" || resource.kind === "StatefulSet" || resource.kind === "DaemonSet" ? " Most workload events live on the child Pods — open a Pod to see them." : ""}
    </p>
  </div>
{:else}
  <table class="w-full border-collapse text-[13px]">
    <thead>
      <tr class="border-b border-[var(--border-color)]">
        <th class="sticky top-0 z-[1] bg-[var(--bg-primary)] px-4 py-2.5 text-left text-[11px] font-medium text-[var(--text-muted)]" style="width: 110px;">Type</th>
        <th class="sticky top-0 z-[1] bg-[var(--bg-primary)] px-4 py-2.5 text-left text-[11px] font-medium text-[var(--text-muted)]" style="width: 180px;">Reason</th>
        <th class="sticky top-0 z-[1] bg-[var(--bg-primary)] px-4 py-2.5 text-left text-[11px] font-medium text-[var(--text-muted)]">Message</th>
        <th class="sticky top-0 z-[1] bg-[var(--bg-primary)] px-4 py-2.5 text-left text-[11px] font-medium text-[var(--text-muted)]" style="width: 70px;">Count</th>
        <th class="sticky top-0 z-[1] bg-[var(--bg-primary)] px-4 py-2.5 text-left text-[11px] font-medium text-[var(--text-muted)]" style="width: 120px;">Last Seen</th>
      </tr>
    </thead>
    <tbody>
      {#each rows as row}
        <tr class="border-b border-[var(--border-color)]">
          <td class="px-4 py-3 align-top">
            <span
              class="inline-flex items-center gap-1.5 text-[12px] font-medium"
              style:color={row.warning ? "var(--status-pending)" : "var(--status-running)"}
            >
              <span class="h-[7px] w-[7px] shrink-0 rounded-full" style:background-color={row.warning ? "var(--status-pending)" : "var(--status-running)"}></span>
              {row.warning ? "Warning" : "Normal"}
            </span>
          </td>
          <td class="px-4 py-3 align-top font-mono text-[12px] text-[var(--text-secondary)]">{row.reason}</td>
          <td class="px-4 py-3 align-top text-[var(--text-muted)]">{row.message}</td>
          <td class="px-4 py-3 align-top font-mono text-[12px] tabular-nums text-[var(--text-secondary)]">{row.count ?? "—"}</td>
          <td class="px-4 py-3 align-top whitespace-nowrap font-mono text-[12px] text-[var(--text-muted)]">{lastSeen(row.ts)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}
