<script lang="ts">
  import CollapsibleCard from "./CollapsibleCard.svelte";
  import InfoRow from "./InfoRow.svelte";

  interface Props {
    spec: Record<string, unknown>;
  }

  let { spec }: Props = $props();

  interface Toleration {
    key?: string;
    operator?: string;
    value?: string;
    effect?: string;
    tolerationSeconds?: number;
  }

  let tolerations = $derived((spec.tolerations as Toleration[]) ?? []);
  let affinity = $derived((spec.affinity as Record<string, unknown>) ?? {});
  let nodeAffinity = $derived((affinity.nodeAffinity as Record<string, unknown>) ?? {});
  let podAffinity = $derived((affinity.podAffinity as Record<string, unknown>) ?? {});
  let podAntiAffinity = $derived((affinity.podAntiAffinity as Record<string, unknown>) ?? {});
  let priorityClassName = $derived((spec.priorityClassName as string) ?? "");
  let priority = $derived(spec.priority as number | undefined);

  let hasNodeAffinity = $derived(Object.keys(nodeAffinity).length > 0);
  let hasPodAffinity = $derived(Object.keys(podAffinity).length > 0);
  let hasPodAntiAffinity = $derived(Object.keys(podAntiAffinity).length > 0);

  let hasContent = $derived(
    tolerations.length > 0 ||
    hasNodeAffinity ||
    hasPodAffinity ||
    hasPodAntiAffinity ||
    priorityClassName !== "" ||
    priority !== undefined
  );

  let totalItems = $derived(
    tolerations.length +
    (hasNodeAffinity ? 1 : 0) +
    (hasPodAffinity ? 1 : 0) +
    (hasPodAntiAffinity ? 1 : 0)
  );

  function formatToleration(t: Toleration): string {
    if (t.operator === "Exists") {
      const key = t.key ?? "*";
      const effect = t.effect ? `:${t.effect}` : "";
      return `${key}${effect} (Exists)`;
    }
    const key = t.key ?? "*";
    const value = t.value ? `=${t.value}` : "";
    const effect = t.effect ? `:${t.effect}` : "";
    const op = t.operator ? ` (${t.operator})` : "";
    return `${key}${value}${effect}${op}`;
  }

  function describeAffinityTerms(obj: Record<string, unknown>): string[] {
    const descriptions: string[] = [];
    const required = obj.requiredDuringSchedulingIgnoredDuringExecution as Record<string, unknown> | undefined;
    const preferred = obj.preferredDuringSchedulingIgnoredDuringExecution as Array<Record<string, unknown>> | undefined;

    if (required) {
      const terms = (required.nodeSelectorTerms as Array<Record<string, unknown>>) ??
        (Array.isArray(required) ? required : [required]);
      descriptions.push(`Required: ${terms.length} term${terms.length !== 1 ? "s" : ""}`);
    }
    if (preferred && preferred.length > 0) {
      descriptions.push(`Preferred: ${preferred.length} rule${preferred.length !== 1 ? "s" : ""}`);
    }
    return descriptions;
  }
</script>

{#if hasContent}
  <CollapsibleCard title="Tolerations & Affinity" count={totalItems}>
    {#if priorityClassName || priority !== undefined}
      {#if priorityClassName}
        <InfoRow label="Priority Class" value={priorityClassName} />
      {/if}
      {#if priority !== undefined}
        <InfoRow label="Priority" value={String(priority)} />
      {/if}
    {/if}

    {#if tolerations.length > 0}
      <div class="border-t border-[var(--border-hover)] px-5 py-3">
        <div class="mb-2 text-[11px] font-medium uppercase tracking-wider text-[var(--text-dimmed)]">Tolerations</div>
      </div>
      {#each tolerations as toleration}
        <div class="flex items-center border-t border-[var(--border-hover)] px-5 py-3">
          <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--text-muted)]">
            {formatToleration(toleration)}
          </span>
          {#if toleration.tolerationSeconds !== undefined}
            <span class="ml-2 shrink-0 text-[10px] text-[var(--text-dimmed)]">{toleration.tolerationSeconds}s</span>
          {/if}
        </div>
      {/each}
    {/if}

    {#if hasNodeAffinity}
      <div class="border-t border-[var(--border-hover)] px-5 py-3">
        <div class="mb-2 text-[11px] font-medium uppercase tracking-wider text-[var(--text-dimmed)]">Node Affinity</div>
        {#each describeAffinityTerms(nodeAffinity) as desc}
          <div class="font-mono text-[11px] text-[var(--text-muted)]">{desc}</div>
        {/each}
      </div>
    {/if}

    {#if hasPodAffinity}
      <div class="border-t border-[var(--border-hover)] px-5 py-3">
        <div class="mb-2 text-[11px] font-medium uppercase tracking-wider text-[var(--text-dimmed)]">Pod Affinity</div>
        {#each describeAffinityTerms(podAffinity) as desc}
          <div class="font-mono text-[11px] text-[var(--text-muted)]">{desc}</div>
        {/each}
      </div>
    {/if}

    {#if hasPodAntiAffinity}
      <div class="border-t border-[var(--border-hover)] px-5 py-3">
        <div class="mb-2 text-[11px] font-medium uppercase tracking-wider text-[var(--text-dimmed)]">Pod Anti-Affinity</div>
        {#each describeAffinityTerms(podAntiAffinity) as desc}
          <div class="font-mono text-[11px] text-[var(--text-muted)]">{desc}</div>
        {/each}
      </div>
    {/if}
  </CollapsibleCard>
{/if}
