<script lang="ts">
  import { Boxes, Layers } from "lucide-svelte";
  import { invoke } from "$lib/ipc/core";
  import type { Resource } from "$lib/types";
  import StatusBadge from "$lib/components/common/StatusBadge.svelte";
  import MetadataSection from "./MetadataSection.svelte";
  import LabelsSection from "./LabelsSection.svelte";
  import DetailSection from "./DetailSection.svelte";
  import KvField from "./KvField.svelte";
  import KvGrid from "./KvGrid.svelte";
  import CollapsibleConditions from "./CollapsibleConditions.svelte";
  import SmartAnnotationsCard from "./SmartAnnotationsCard.svelte";

  interface Props {
    resource: Resource;
  }

  let { resource }: Props = $props();

  let status = $derived(resource.status ?? {});
  let spec = $derived(resource.spec ?? {});
  let phase = $derived((status.phase as string) ?? "Unknown");
  let finalizers = $derived((spec.finalizers as string[]) ?? []);
  let conditions = $derived(
    (status.conditions as Array<{ type: string; status: string; reason?: string; message?: string }>) ?? [],
  );
  let labels = $derived(resource.metadata.labels ?? {});
  let annotations = $derived(resource.metadata.annotations ?? {});

  // Namespace conditions are all "problem" conditions: True means something
  // is stuck (NamespaceDeletionContentFailure, …). False is the healthy state.
  function isConditionHealthy(_type: string, s: string): boolean {
    return s !== "True";
  }

  // A handful of kinds, counted with the metadata-only batch command the
  // sidebar already uses — one IPC call, no object bodies.
  const COUNTED: Array<{ type: string; label: string }> = [
    { type: "pods", label: "Pods" },
    { type: "deployments", label: "Deployments" },
    { type: "statefulsets", label: "StatefulSets" },
    { type: "daemonsets", label: "DaemonSets" },
    { type: "jobs", label: "Jobs" },
    { type: "cronjobs", label: "CronJobs" },
    { type: "services", label: "Services" },
    { type: "ingresses", label: "Ingresses" },
    { type: "configmaps", label: "ConfigMaps" },
    { type: "secrets", label: "Secrets" },
    { type: "persistentvolumeclaims", label: "PVCs" },
  ];

  let counts = $state<Record<string, number> | null>(null);
  let countsError = $state<string | null>(null);

  $effect(() => {
    const name = resource.metadata.name;
    let cancelled = false;
    counts = null;
    countsError = null;
    invoke<Record<string, number>>("get_resource_counts", {
      resourceTypes: COUNTED.map((c) => c.type),
      namespace: name,
    })
      .then((result) => {
        if (!cancelled) counts = result ?? {};
      })
      .catch((err) => {
        if (!cancelled) countsError = String(err);
      });
    return () => { cancelled = true; };
  });
</script>

<div class="select-text">
  <MetadataSection {resource} />

  <DetailSection title="Namespace" icon={Boxes}>
    <KvGrid>
      <KvField label="Phase">
        <StatusBadge status={phase} />
      </KvField>
      {#if resource.metadata.deletion_timestamp}
        <KvField label="Deleting since" value={resource.metadata.deletion_timestamp} mono={false} />
      {/if}
      {#if finalizers.length > 0}
        <KvField label="Finalizers" value={finalizers.join(", ")} />
      {/if}
    </KvGrid>
  </DetailSection>

  {#if conditions.length > 0}
    <CollapsibleConditions {conditions} healthFn={isConditionHealthy} />
  {/if}

  <DetailSection title="Resources" icon={Layers}>
    {#snippet actions()}
      {#if counts === null && !countsError}
        <span class="font-mono text-[11px] text-[var(--text-muted)]">…</span>
      {/if}
    {/snippet}
    {#if countsError}
      <span class="text-[12px] text-[var(--text-muted)]">Counts unavailable: {countsError}</span>
    {:else}
      <div class="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(120px,1fr))]" data-testid="namespace-counts">
        {#each COUNTED as c (c.type)}
          {@const n = counts?.[c.type]}
          <div class="flex flex-col gap-0.5 rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2">
            <span class="font-mono text-[15px] font-semibold {n ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}">
              {counts === null ? "–" : (n ?? 0)}
            </span>
            <span class="text-[11px] text-[var(--text-muted)]">{c.label}</span>
          </div>
        {/each}
      </div>
    {/if}
  </DetailSection>

  <LabelsSection {labels} />
  <SmartAnnotationsCard {annotations} />
</div>
