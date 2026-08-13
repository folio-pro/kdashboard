<script lang="ts">
  import { Badge } from "$lib/components/ui";
  import CollapsibleCard from "./CollapsibleCard.svelte";

  interface Props {
    spec: Record<string, unknown>;
  }

  let { spec }: Props = $props();

  interface ScalingPolicy {
    type: string;
    value: number;
    periodSeconds: number;
  }

  interface ScalingDirection {
    stabilizationWindowSeconds?: number;
    selectPolicy?: string;
    policies: ScalingPolicy[];
  }

  let behavior = $derived((spec.behavior as Record<string, unknown>) ?? {});

  function parseDirection(dir: Record<string, unknown> | undefined): ScalingDirection | null {
    if (!dir) return null;
    const policies = (dir.policies as Array<Record<string, unknown>>) ?? [];
    return {
      stabilizationWindowSeconds: dir.stabilizationWindowSeconds as number | undefined,
      selectPolicy: dir.selectPolicy as string | undefined,
      policies: policies.map(p => ({
        type: (p.type as string) ?? "?",
        value: (p.value as number) ?? 0,
        periodSeconds: (p.periodSeconds as number) ?? 0,
      })),
    };
  }

  let scaleUp = $derived(parseDirection(behavior.scaleUp as Record<string, unknown> | undefined));
  let scaleDown = $derived(parseDirection(behavior.scaleDown as Record<string, unknown> | undefined));

  let hasContent = $derived(scaleUp !== null || scaleDown !== null);
</script>

{#snippet directionSection(label: string, dir: ScalingDirection, color: string)}
  <div class="border-t border-[var(--border-hover)] px-5 py-3">
    <div class="mb-2 flex items-center gap-2">
      <span class="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">{label}</span>
      {#if dir.selectPolicy}
        <Badge appearance="surface" tone="muted" mono>{dir.selectPolicy}</Badge>
      {/if}
    </div>
    {#if dir.stabilizationWindowSeconds !== undefined}
      <div class="mb-2 font-mono text-[11px] text-[var(--text-muted)]">
        stabilization: {dir.stabilizationWindowSeconds}s
      </div>
    {/if}
    {#if dir.policies.length > 0}
      <div class="flex flex-col gap-1.5">
        {#each dir.policies as policy}
          <div class="flex items-center gap-2">
            <Badge style="--tone: {color};">{policy.type}</Badge>
            <span class="font-mono text-[11px] text-[var(--text-primary)]">{policy.value}</span>
            <span class="text-[11px] text-[var(--text-muted)]">per {policy.periodSeconds}s</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

{#if hasContent}
  <CollapsibleCard title="Scaling Behavior">
    {#if scaleUp}
      {@render directionSection("Scale Up", scaleUp, "var(--status-running)")}
    {/if}
    {#if scaleDown}
      {@render directionSection("Scale Down", scaleDown, "var(--status-pending)")}
    {/if}
  </CollapsibleCard>
{/if}
