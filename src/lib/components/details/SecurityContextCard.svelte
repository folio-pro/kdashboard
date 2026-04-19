<script lang="ts">
  import InfoRow from "./InfoRow.svelte";
  import CollapsibleCard from "./CollapsibleCard.svelte";

  interface Props {
    spec: Record<string, unknown>;
  }

  let { spec }: Props = $props();

  let podSecurity = $derived((spec.securityContext as Record<string, unknown>) ?? {});
  let serviceAccountName = $derived((spec.serviceAccountName as string) ?? "");
  let automountToken = $derived(spec.automountServiceAccountToken as boolean | undefined);

  let containers = $derived((spec.containers as Array<Record<string, unknown>>) ?? []);

  interface ContainerSecurity {
    name: string;
    privileged: boolean | undefined;
    readOnlyRootFilesystem: boolean | undefined;
    allowPrivilegeEscalation: boolean | undefined;
    runAsUser: number | undefined;
    runAsNonRoot: boolean | undefined;
    capAdd: string[];
    capDrop: string[];
  }

  let containerSecurityContexts = $derived.by(() => {
    return containers.map((c): ContainerSecurity => {
      const sc = (c.securityContext as Record<string, unknown>) ?? {};
      const caps = (sc.capabilities as Record<string, unknown>) ?? {};
      return {
        name: (c.name as string) ?? "unknown",
        privileged: sc.privileged as boolean | undefined,
        readOnlyRootFilesystem: sc.readOnlyRootFilesystem as boolean | undefined,
        allowPrivilegeEscalation: sc.allowPrivilegeEscalation as boolean | undefined,
        runAsUser: sc.runAsUser as number | undefined,
        runAsNonRoot: sc.runAsNonRoot as boolean | undefined,
        capAdd: (caps.add as string[]) ?? [],
        capDrop: (caps.drop as string[]) ?? [],
      };
    });
  });

  let hasPodSecurity = $derived(Object.keys(podSecurity).length > 0);
  let hasContainerSecurity = $derived(containerSecurityContexts.some(c =>
    c.privileged !== undefined ||
    c.readOnlyRootFilesystem !== undefined ||
    c.allowPrivilegeEscalation !== undefined ||
    c.runAsUser !== undefined ||
    c.runAsNonRoot !== undefined ||
    c.capAdd.length > 0 ||
    c.capDrop.length > 0
  ));
  let hasServiceAccount = $derived(serviceAccountName !== "" || automountToken !== undefined);

  let hasContent = $derived(hasPodSecurity || hasContainerSecurity || hasServiceAccount);

  function dangerColor(isDangerous: boolean): string {
    return isDangerous ? "var(--status-failed)" : "var(--status-running)";
  }
</script>

{#if hasContent}
  <CollapsibleCard title="Security Context">
    <!-- Pod-level security -->
    {#if hasPodSecurity || hasServiceAccount}
      <div class="border-t border-[var(--border-hover)] px-5 py-3">
        <div class="mb-2 text-[11px] font-medium uppercase tracking-wider text-[var(--text-dimmed)]">Pod Level</div>
      </div>
      {#if serviceAccountName}
        <InfoRow label="Service Account" value={serviceAccountName} />
      {/if}
      {#if automountToken !== undefined}
        <InfoRow label="Automount Token" value={String(automountToken)} valueColor={automountToken ? "var(--status-pending)" : "var(--status-running)"} />
      {/if}
      {#if podSecurity.runAsUser !== undefined}
        <InfoRow label="Run As User" value={String(podSecurity.runAsUser)} />
      {/if}
      {#if podSecurity.runAsGroup !== undefined}
        <InfoRow label="Run As Group" value={String(podSecurity.runAsGroup)} />
      {/if}
      {#if podSecurity.fsGroup !== undefined}
        <InfoRow label="FS Group" value={String(podSecurity.fsGroup)} />
      {/if}
      {#if podSecurity.runAsNonRoot !== undefined}
        <InfoRow label="Run As Non-Root" value={String(podSecurity.runAsNonRoot)} valueColor={dangerColor(podSecurity.runAsNonRoot as boolean)} />
      {/if}
      {#if podSecurity.supplementalGroups}
        <InfoRow label="Supplemental Groups" value={(podSecurity.supplementalGroups as number[]).join(", ")} />
      {/if}
      {#if podSecurity.seccompProfile}
        {@const profile = podSecurity.seccompProfile as Record<string, unknown>}
        <InfoRow label="Seccomp Profile" value={(profile.type as string) ?? "Unknown"} />
      {/if}
    {/if}

    <!-- Container-level security -->
    {#each containerSecurityContexts as cs}
      {@const hasAny =
        cs.privileged !== undefined ||
        cs.readOnlyRootFilesystem !== undefined ||
        cs.allowPrivilegeEscalation !== undefined ||
        cs.runAsUser !== undefined ||
        cs.runAsNonRoot !== undefined ||
        cs.capAdd.length > 0 ||
        cs.capDrop.length > 0}
      {#if hasAny}
        <div class="border-t border-[var(--border-hover)] px-5 py-3">
          <div class="mb-1 text-[11px] font-medium uppercase tracking-wider text-[var(--text-dimmed)]">Container: {cs.name}</div>
        </div>
        {#if cs.privileged !== undefined}
          <InfoRow label="Privileged" value={String(cs.privileged)} valueColor={dangerColor(!cs.privileged)} />
        {/if}
        {#if cs.allowPrivilegeEscalation !== undefined}
          <InfoRow label="Privilege Escalation" value={String(cs.allowPrivilegeEscalation)} valueColor={dangerColor(!cs.allowPrivilegeEscalation)} />
        {/if}
        {#if cs.readOnlyRootFilesystem !== undefined}
          <InfoRow label="Read-Only Root FS" value={String(cs.readOnlyRootFilesystem)} valueColor={dangerColor(!cs.readOnlyRootFilesystem)} />
        {/if}
        {#if cs.runAsUser !== undefined}
          <InfoRow label="Run As User" value={String(cs.runAsUser)} />
        {/if}
        {#if cs.runAsNonRoot !== undefined}
          <InfoRow label="Run As Non-Root" value={String(cs.runAsNonRoot)} valueColor={dangerColor(cs.runAsNonRoot)} />
        {/if}
        {#if cs.capAdd.length > 0}
          <InfoRow label="Capabilities Add">
            <div class="flex flex-wrap gap-1">
              {#each cs.capAdd as cap}
                <span class="rounded bg-[var(--status-failed)]/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-[var(--status-failed)]">{cap}</span>
              {/each}
            </div>
          </InfoRow>
        {/if}
        {#if cs.capDrop.length > 0}
          <InfoRow label="Capabilities Drop">
            <div class="flex flex-wrap gap-1">
              {#each cs.capDrop as cap}
                <span class="rounded bg-[var(--status-running)]/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-[var(--status-running)]">{cap}</span>
              {/each}
            </div>
          </InfoRow>
        {/if}
      {/if}
    {/each}
  </CollapsibleCard>
{/if}
