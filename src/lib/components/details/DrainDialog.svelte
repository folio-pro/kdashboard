<script lang="ts">
  import { Dialog, DialogContent } from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { toastStore } from "$lib/stores/toast.svelte";
  import {
    drainNode,
    summarizeDrain,
    type DrainProgress,
    type DrainResult,
  } from "$lib/actions/node-ops";

  let { open = $bindable(false), nodeName }: { open: boolean; nodeName: string } = $props();

  let ignoreDaemonSets = $state(true);
  let deleteEmptyDirData = $state(false);
  let force = $state(false);
  let running = $state(false);
  let error = $state("");
  let progress = $state<DrainProgress | null>(null);
  let result = $state<DrainResult | null>(null);

  $effect(() => {
    if (open) {
      error = "";
      progress = null;
      result = null;
    }
  });

  let progressLabel = $derived.by(() => {
    if (!progress) return "";
    switch (progress.phase) {
      case "cordoning":
        return "Cordoning node…";
      case "listing":
        return "Listing pods on the node…";
      case "evicting":
        return `Evicting ${progress.pod ?? ""} (${progress.evicted}/${progress.total})`;
      case "waiting":
        return "Waiting for a PodDisruptionBudget…";
      case "done":
        return `Evicted ${progress.evicted}/${progress.total}`;
    }
  });

  let percent = $derived(
    progress && progress.total > 0 ? Math.round((progress.evicted / progress.total) * 100) : 0,
  );

  async function handleDrain() {
    running = true;
    error = "";
    result = null;
    try {
      const res = await drainNode(
        nodeName,
        { ignoreDaemonSets, deleteEmptyDirData, force },
        (p) => { progress = p; },
      );
      result = res;
      if (res.failed.length > 0 || res.timed_out) {
        toastStore.error(`Drain of ${nodeName} incomplete`, summarizeDrain(res));
      } else {
        toastStore.success(`Node ${nodeName} drained`, summarizeDrain(res));
      }
    } catch (err) {
      error = String(err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  }
</script>

<Dialog bind:open>
  <DialogContent class="sm:max-w-[460px]" aria-labelledby="drain-dialog-title" aria-describedby="drain-dialog-desc">
    <div class="flex flex-col gap-4 p-1">
      <div>
        <h3 id="drain-dialog-title" class="text-sm font-semibold text-[var(--text-primary)]">Drain node</h3>
        <p id="drain-dialog-desc" class="mt-1 text-[11px] text-[var(--text-muted)]">
          {nodeName} — the node is cordoned first, then every evictable pod is evicted through the
          Eviction API, so PodDisruptionBudgets are respected.
        </p>
      </div>

      <div class="flex flex-col gap-2.5">
        <label class="flex items-start gap-2.5 text-[12px] text-[var(--text-secondary)]">
          <Checkbox checked={ignoreDaemonSets} onCheckedChange={(v: boolean) => (ignoreDaemonSets = v)} disabled={running} aria-label="Ignore DaemonSets" />
          <span>
            Ignore DaemonSets
            <span class="block text-[10.5px] text-[var(--text-dimmed)]">DaemonSet pods stay — they are recreated on the node immediately anyway.</span>
          </span>
        </label>

        <label class="flex items-start gap-2.5 text-[12px] text-[var(--text-secondary)]">
          <Checkbox checked={deleteEmptyDirData} onCheckedChange={(v: boolean) => (deleteEmptyDirData = v)} disabled={running} aria-label="Delete emptyDir data" />
          <span>
            Delete emptyDir data
            <span class="block text-[10.5px] text-[var(--text-dimmed)]">Pods with emptyDir volumes lose that data permanently.</span>
          </span>
        </label>

        <label class="flex items-start gap-2.5 text-[12px] text-[var(--text-secondary)]">
          <Checkbox checked={force} onCheckedChange={(v: boolean) => (force = v)} disabled={running} aria-label="Force" />
          <span>
            Force
            <span class="block text-[10.5px] text-[var(--text-dimmed)]">Evict pods with no controller — nothing will recreate them.</span>
          </span>
        </label>
      </div>

      {#if running || progress}
        <div class="flex flex-col gap-1.5">
          <div class="h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
            <div class="h-full rounded-full bg-[var(--accent)] transition-all duration-300" style="width: {percent}%"></div>
          </div>
          <span class="font-mono text-[10.5px] text-[var(--text-muted)]">{progressLabel}</span>
        </div>
      {/if}

      {#if error}
        <p class="whitespace-pre-wrap rounded border border-[var(--status-failed)]/30 bg-[var(--status-failed)]/5 p-2 text-[11px] text-[var(--status-failed)]">{error}</p>
      {/if}

      {#if result}
        <div class="flex flex-col gap-1 text-[11px] text-[var(--text-secondary)]">
          <span>{summarizeDrain(result)}</span>
          {#each result.failed as f}
            <span class="font-mono text-[10.5px] text-[var(--status-failed)]">{f.namespace}/{f.pod}: {f.error}</span>
          {/each}
          {#each result.skipped as s}
            <span class="font-mono text-[10.5px] text-[var(--text-dimmed)]">{s.namespace}/{s.pod}: {s.reason}</span>
          {/each}
        </div>
      {/if}

      <div class="flex justify-end gap-2">
        <Button variant="outline" size="sm" onclick={() => (open = false)} disabled={running}>
          {result ? "Close" : "Cancel"}
        </Button>
        <Button variant="destructive" size="sm" onclick={handleDrain} disabled={running}>
          {running ? "Draining…" : result ? "Drain again" : `Drain ${nodeName}`}
        </Button>
      </div>
    </div>
  </DialogContent>
</Dialog>
