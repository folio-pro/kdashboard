<script lang="ts">
  import { Box, ArrowUpRight } from "lucide-svelte";
  import { Spinner } from "$lib/components/ui";
  import { invoke } from "$lib/ipc/core";
  import type { Resource, ResourceList } from "$lib/types";
  import StatusBadge from "$lib/components/common/StatusBadge.svelte";
  import { openResourceDetail } from "$lib/actions/navigation";
  import { podStatus, podReadyCount, podRestarts } from "$lib/utils/pod-status";
  import { formatAge } from "$lib/utils/age";

  interface Props {
    nodeName: string;
  }

  let { nodeName }: Props = $props();

  let pods = $state<Resource[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // list_resources has no field-selector option, so this is the cluster-wide
  // lean pod list filtered here — the same list the Pods table loads, so it is
  // cheap enough for a detail card and stays current on every re-open.
  $effect(() => {
    const node = nodeName;
    let cancelled = false;
    loading = true;
    error = null;
    invoke<ResourceList>("list_resources", { resourceType: "pods", namespace: null })
      .then((result) => {
        if (cancelled) return;
        pods = result.items
          .filter((p) => (p.spec?.nodeName as string | undefined) === node)
          .sort((a, b) =>
            (a.metadata.namespace ?? "").localeCompare(b.metadata.namespace ?? "") ||
            a.metadata.name.localeCompare(b.metadata.name),
          );
      })
      .catch((err) => {
        if (!cancelled) error = String(err);
      })
      .finally(() => {
        if (!cancelled) loading = false;
      });
    return () => { cancelled = true; };
  });
</script>

<div class="border-b border-[var(--border-color)]" data-testid="node-pods">
  <div class="flex items-center justify-between px-6 py-4">
    <div class="flex items-center gap-2">
      <Box class="h-3.5 w-3.5 text-[var(--text-muted)]" />
      <span class="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">Pods on this node</span>
    </div>
    <span class="font-mono text-[11px] text-[var(--text-muted)]">
      {#if loading}<Spinner class="h-3 w-3" />{:else}{pods.length}{/if}
    </span>
  </div>

  {#if error}
    <div class="border-t border-[var(--border-hover)] px-6 py-4">
      <span class="text-[12px] text-[var(--status-failed)]">Failed to list pods: {error}</span>
    </div>
  {:else if !loading && pods.length === 0}
    <div class="border-t border-[var(--border-hover)] px-6 py-4">
      <span class="text-[12px] text-[var(--text-muted)]">No pods scheduled on this node</span>
    </div>
  {:else if pods.length > 0}
    <div class="border-t border-[var(--border-hover)]">
      <table class="w-full border-collapse text-[12px]">
        <thead>
          <tr class="border-b border-[var(--border-hover)]">
            <th class="px-6 py-2 text-left text-[11px] font-medium text-[var(--text-muted)]">Pod</th>
            <th class="px-3 py-2 text-left text-[11px] font-medium text-[var(--text-muted)]">Namespace</th>
            <th class="px-3 py-2 text-left text-[11px] font-medium text-[var(--text-muted)]">Status</th>
            <th class="px-3 py-2 text-right text-[11px] font-medium text-[var(--text-muted)]">Ready</th>
            <th class="px-3 py-2 text-right text-[11px] font-medium text-[var(--text-muted)]">Restarts</th>
            <th class="px-3 py-2 text-right text-[11px] font-medium text-[var(--text-muted)]">Age</th>
            <th class="w-8"></th>
          </tr>
        </thead>
        <tbody>
          {#each pods as pod (pod.metadata.uid)}
            {@const ready = podReadyCount(pod)}
            {@const restarts = podRestarts(pod)}
            <tr
              class="node-pod cursor-pointer border-b border-[var(--border-hover)] transition-colors last:border-b-0 hover:bg-[var(--bg-tertiary)]"
              onclick={() => openResourceDetail(pod, "pods")}
              title="Open {pod.metadata.name}"
            >
              <td class="max-w-[280px] truncate px-6 py-2 font-mono text-[12px] text-[var(--text-primary)]">{pod.metadata.name}</td>
              <td class="px-3 py-2 text-[12px] text-[var(--text-secondary)]">{pod.metadata.namespace ?? "—"}</td>
              <td class="px-3 py-2"><StatusBadge status={podStatus(pod).label} /></td>
              <td class="px-3 py-2 text-right font-mono text-[12px] {ready.ready < ready.total ? 'text-[var(--status-pending)]' : 'text-[var(--text-primary)]'}">{ready.ready}/{ready.total}</td>
              <td class="px-3 py-2 text-right font-mono text-[12px] {restarts.count > 0 ? 'text-[var(--status-pending)]' : 'text-[var(--text-muted)]'}">{restarts.count}</td>
              <td class="px-3 py-2 text-right font-mono text-[12px] text-[var(--text-muted)]">{formatAge(pod.metadata.creation_timestamp)}</td>
              <td class="px-3 py-2 text-right"><ArrowUpRight class="node-pod-arrow inline h-3.5 w-3.5 text-[var(--text-muted)] transition-transform" /></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .node-pod:hover :global(.node-pod-arrow) {
    transform: translate(1px, -1px);
  }
</style>
