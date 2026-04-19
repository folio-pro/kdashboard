<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { Dialog, DialogContent } from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Minus, Plus } from "lucide-svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { toastStore } from "$lib/stores/toast.svelte";
  import { decrementReplicas, incrementReplicas, isScaleEnabled, shouldShowDelta, getButtonLabel } from "./scale-dialog";

  let { open = $bindable(false), resource }: {
    open: boolean;
    resource: { kind: string; name: string; namespace: string; currentReplicas: number };
  } = $props();

  let replicas = $state(0);
  let loading = $state(false);
  let error = $state("");

  $effect(() => {
    if (open && resource) {
      replicas = resource.currentReplicas;
      error = "";
    }
  });

  async function handleScale() {
    loading = true;
    error = "";
    try {
      await invoke("scale_workload", {
        kind: resource.kind,
        name: resource.name,
        namespace: resource.namespace,
        replicas,
      });
      toastStore.success("Scaled", `${resource.kind} "${resource.name}" scaled to ${replicas} replicas`);
      open = false;
      await k8sStore.refreshResources();
    } catch (err) {
      error = String(err);
      toastStore.error("Scale failed", String(err));
    } finally {
      loading = false;
    }
  }
</script>

<Dialog bind:open>
  <DialogContent class="sm:max-w-[380px]" aria-labelledby="scale-dialog-title" aria-describedby="scale-dialog-desc">
    <div class="flex flex-col gap-4 p-1">
      <div>
        <h3 id="scale-dialog-title" class="text-sm font-semibold text-[var(--text-primary)]">Scale {resource.kind}</h3>
        <p id="scale-dialog-desc" class="mt-1 text-[11px] text-[var(--text-muted)]">{resource.name}</p>
      </div>

      <div class="flex items-center justify-center gap-4">
        <Button variant="outline" size="icon" onclick={() => replicas = decrementReplicas(replicas)} disabled={loading} aria-label="Decrease replicas">
          <Minus class="h-4 w-4" />
        </Button>
        <div class="flex flex-col items-center">
          <span class="text-3xl font-bold tabular-nums text-[var(--text-primary)]">{replicas}</span>
          <span class="text-[10px] text-[var(--text-muted)]">replicas</span>
        </div>
        <Button variant="outline" size="icon" onclick={() => replicas = incrementReplicas(replicas)} disabled={loading} aria-label="Increase replicas">
          <Plus class="h-4 w-4" />
        </Button>
      </div>

      {#if shouldShowDelta(resource.currentReplicas, replicas)}
        <p class="text-center text-[11px] text-[var(--text-muted)]">
          {resource.currentReplicas} → {replicas}
        </p>
      {/if}

      {#if error}
        <p class="text-xs text-[var(--status-failed)]">{error}</p>
      {/if}

      <div class="flex justify-end gap-2">
        <Button variant="outline" size="sm" onclick={() => open = false} disabled={loading}>Cancel</Button>
        <Button size="sm" onclick={handleScale} disabled={!isScaleEnabled(loading, replicas, resource.currentReplicas)}>
          {getButtonLabel(loading)}
        </Button>
      </div>
    </div>
  </DialogContent>
</Dialog>
