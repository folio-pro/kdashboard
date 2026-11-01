<script lang="ts">
  import { Badge } from "$lib/components/ui";
  import InfoRow from "./InfoRow.svelte";

  interface Props {
    spec: Record<string, unknown>;
    kind: string;
  }

  let { spec, kind }: Props = $props();

  // Deployment strategy
  let deployStrategy = $derived((spec.strategy as Record<string, unknown>) ?? {});
  let deployStrategyType = $derived((deployStrategy.type as string) ?? "");
  let deployRollingUpdate = $derived((deployStrategy.rollingUpdate as Record<string, unknown>) ?? {});

  // StatefulSet strategy
  let updateStrategy = $derived((spec.updateStrategy as Record<string, unknown>) ?? {});
  let updateStrategyType = $derived((updateStrategy.type as string) ?? "");
  let rollingUpdate = $derived((updateStrategy.rollingUpdate as Record<string, unknown>) ?? {});
  let podManagementPolicy = $derived((spec.podManagementPolicy as string) ?? "");
  let pvcRetentionPolicy = $derived((spec.persistentVolumeClaimRetentionPolicy as Record<string, unknown>) ?? {});

  let isDeployment = $derived(kind === "Deployment");
  let isStatefulSet = $derived(kind === "StatefulSet");
  let isDaemonSet = $derived(kind === "DaemonSet");

  let strategyType = $derived(isDeployment ? deployStrategyType : updateStrategyType);

</script>

<div class="border-b border-[var(--border-color)]">
  <div class="flex items-center justify-between px-6 py-4">
    <span class="text-[11px] font-medium text-[var(--text-muted)]">Update Strategy</span>
    <Badge appearance="surface" size="sm" mono class="text-[var(--text-primary)]">{strategyType || "—"}</Badge>
  </div>

  {#if isDeployment}
    {#if deployStrategyType === "RollingUpdate"}
      <InfoRow label="Max surge" value={String(deployRollingUpdate.maxSurge ?? "25%")} />
      <InfoRow label="Max unavailable" value={String(deployRollingUpdate.maxUnavailable ?? "25%")} />
    {/if}
    {#if spec.revisionHistoryLimit !== undefined}
      <InfoRow label="Revision history" value={String(spec.revisionHistoryLimit)} />
    {/if}
    {#if spec.minReadySeconds !== undefined}
      <InfoRow label="Min ready seconds" value={String(spec.minReadySeconds)} />
    {/if}
    {#if spec.progressDeadlineSeconds !== undefined}
      <InfoRow label="Progress deadline" value={`${spec.progressDeadlineSeconds}s`} />
    {/if}
    {#if spec.paused}
      <InfoRow label="Paused" value="true" valueColor="var(--status-pending)" />
    {/if}
  {/if}

  {#if isStatefulSet}
    {#if updateStrategyType === "RollingUpdate" && rollingUpdate.partition !== undefined}
      <InfoRow label="Partition" value={String(rollingUpdate.partition)} />
    {/if}
    {#if podManagementPolicy}
      <InfoRow label="Pod management" value={podManagementPolicy} />
    {/if}
    {#if Object.keys(pvcRetentionPolicy).length > 0}
      {#if pvcRetentionPolicy.whenDeleted}
        <InfoRow label="PVC when deleted" value={String(pvcRetentionPolicy.whenDeleted)} />
      {/if}
      {#if pvcRetentionPolicy.whenScaled}
        <InfoRow label="PVC when scaled" value={String(pvcRetentionPolicy.whenScaled)} />
      {/if}
    {/if}
  {/if}

  {#if isDaemonSet}
    {#if updateStrategyType === "RollingUpdate"}
      {#if rollingUpdate.maxUnavailable !== undefined}
        <InfoRow label="Max unavailable" value={String(rollingUpdate.maxUnavailable)} />
      {/if}
      {#if rollingUpdate.maxSurge !== undefined}
        <InfoRow label="Max surge" value={String(rollingUpdate.maxSurge)} />
      {/if}
    {/if}
  {/if}
</div>
