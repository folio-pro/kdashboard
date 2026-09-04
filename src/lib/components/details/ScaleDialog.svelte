<script lang="ts">
  import { invoke } from "$lib/ipc/core";
  import { Dialog, DialogContent } from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Minus, Plus } from "lucide-svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { toastStore } from "$lib/stores/toast.svelte";
  import { decrementReplicas, incrementReplicas, isScaleEnabled, shouldShowDelta, getButtonLabel, findOwningAutoscaler, autoscalerWarning, type OwningAutoscaler } from "./scale-dialog";
  import type { Resource } from "$lib/types";
  import { AlertTriangle } from "lucide-svelte";

  let { open = $bindable(false), resource }: {
    open: boolean;
    resource: { kind: string; name: string; namespace: string; currentReplicas: number };
  } = $props();

  let replicas = $state(0);
  let loading = $state(false);
  let error = $state("");

  // The HPA owning this workload, looked up when the dialog opens. A manual
  // scale under an HPA is overwritten on its next sync; the user must see
  // that here, where the decision is made, not only on the detail page.
  let owningHpa = $state<OwningAutoscaler | null>(null);
  let hpaWarning = $derived(autoscalerWarning(owningHpa, replicas));

  $effect(() => {
    if (open && resource) {
      replicas = resource.currentReplicas;
      error = "";
      owningHpa = null;
      const target = { kind: resource.kind, name: resource.name, namespace: resource.namespace };
      invoke<{ items: Resource[] }>("list_resources", { resourceType: "hpa", namespace: resource.namespace })
        .then((list) => {
          owningHpa = findOwningAutoscaler(list.items, target);
        })
        .catch(() => {
          // No HPA API or no permission: nothing to warn about.
        });
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
        <h3 id="scale-dialog-title" class="text-[13px] font-semibold text-[var(--text-primary)]">Scale {resource.kind}</h3>
        <p id="scale-dialog-desc" class="mt-1 text-[11px] text-[var(--text-muted)]">{resource.name}</p>
      </div>

      <div class="flex items-center justify-center gap-4">
        <Button variant="outline" size="icon-lg" onclick={() => replicas = decrementReplicas(replicas)} disabled={loading} aria-label="Decrease replicas">
          <Minus class="h-4 w-4" />
        </Button>
        <div class="flex flex-col items-center">
          <span class="text-3xl font-bold tabular-nums text-[var(--text-primary)]">{replicas}</span>
          <span class="text-[10px] text-[var(--text-muted)]">replicas</span>
        </div>
        <Button variant="outline" size="icon-lg" onclick={() => replicas = incrementReplicas(replicas)} disabled={loading} aria-label="Increase replicas">
          <Plus class="h-4 w-4" />
        </Button>
      </div>

      {#if shouldShowDelta(resource.currentReplicas, replicas)}
        <p class="text-center text-[11px] text-[var(--text-muted)]">
          {resource.currentReplicas} → {replicas}
        </p>
      {/if}

      {#if hpaWarning}
        <p class="flex items-start gap-2 rounded-md border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/10 px-2.5 py-2 text-[11px] leading-relaxed text-[var(--text-secondary)]" data-testid="scale-hpa-warning">
          <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--status-warning)]" />
          <span>{hpaWarning}</span>
        </p>
      {/if}

      {#if error}
        <p class="text-[12px] text-[var(--status-failed)]">{error}</p>
      {/if}

      <div class="flex justify-end gap-2">
        <Button variant="outline" size="md" onclick={() => open = false} disabled={loading}>Cancel</Button>
        <Button size="md" onclick={handleScale} disabled={!isScaleEnabled(loading, replicas, resource.currentReplicas)}>
          {getButtonLabel(loading)}
        </Button>
      </div>
    </div>
  </DialogContent>
</Dialog>
