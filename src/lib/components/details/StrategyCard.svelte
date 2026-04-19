<script lang="ts">
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

<div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
  <div class="flex items-center justify-between px-5 py-4">
    <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">Update Strategy</h3>
    <span class="rounded bg-[var(--bg-tertiary)] px-2 py-0.5 font-mono text-[11px] font-medium text-[var(--text-primary)]">{strategyType || "—"}</span>
  </div>

  {#if isDeployment}
    {#if deployStrategyType === "RollingUpdate"}
      <InfoRow label="Max Surge" value={String(deployRollingUpdate.maxSurge ?? "25%")} />
      <InfoRow label="Max Unavailable" value={String(deployRollingUpdate.maxUnavailable ?? "25%")} />
    {/if}
    {#if spec.revisionHistoryLimit !== undefined}
      <InfoRow label="Revision History" value={String(spec.revisionHistoryLimit)} />
    {/if}
    {#if spec.minReadySeconds !== undefined}
      <InfoRow label="Min Ready Seconds" value={String(spec.minReadySeconds)} />
    {/if}
    {#if spec.progressDeadlineSeconds !== undefined}
      <InfoRow label="Progress Deadline" value={`${spec.progressDeadlineSeconds}s`} />
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
      <InfoRow label="Pod Management" value={podManagementPolicy} />
    {/if}
    {#if Object.keys(pvcRetentionPolicy).length > 0}
      {#if pvcRetentionPolicy.whenDeleted}
        <InfoRow label="PVC When Deleted" value={String(pvcRetentionPolicy.whenDeleted)} />
      {/if}
      {#if pvcRetentionPolicy.whenScaled}
        <InfoRow label="PVC When Scaled" value={String(pvcRetentionPolicy.whenScaled)} />
      {/if}
    {/if}
  {/if}

  {#if isDaemonSet}
    {#if updateStrategyType === "RollingUpdate"}
      {#if rollingUpdate.maxUnavailable !== undefined}
        <InfoRow label="Max Unavailable" value={String(rollingUpdate.maxUnavailable)} />
      {/if}
      {#if rollingUpdate.maxSurge !== undefined}
        <InfoRow label="Max Surge" value={String(rollingUpdate.maxSurge)} />
      {/if}
    {/if}
  {/if}
</div>
