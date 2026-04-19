<script lang="ts">
  import StatusBadge from "$lib/components/common/StatusBadge.svelte";
  import CollapsibleCard from "./CollapsibleCard.svelte";
  import { getContainerState } from "$lib/utils/k8s-helpers";

  interface Props {
    spec: Record<string, unknown>;
    status: Record<string, unknown>;
  }

  let { spec, status }: Props = $props();

  interface InitContainer {
    name: string;
    image: string;
    command: string[];
    args: string[];
    state: string;
    restartCount: number;
  }

  let initContainers = $derived.by(() => {
    const specInit = (spec.initContainers as Array<Record<string, unknown>>) ?? [];
    const statusInit = (status.initContainerStatuses as Array<Record<string, unknown>>) ?? [];
    const statusMap = new Map(statusInit.map(s => [(s.name as string), s]));

    return specInit.map((c): InitContainer => {
      const name = (c.name as string) ?? "unknown";
      const s = statusMap.get(name);
      return {
        name,
        image: (c.image as string) ?? "",
        command: (c.command as string[]) ?? [],
        args: (c.args as string[]) ?? [],
        state: s ? getContainerState((s.state as Record<string, unknown>) ?? {}) : "Unknown",
        restartCount: s ? ((s.restartCount as number) ?? 0) : 0,
      };
    });
  });

  let hasContent = $derived(initContainers.length > 0);
</script>

{#if hasContent}
  <CollapsibleCard title="Init Containers" count={initContainers.length}>
    {#each initContainers as container}
      <div class="border-t border-[var(--border-hover)] px-5 py-4">
        <div class="mb-2 flex items-center justify-between">
          <span class="text-[12px] font-semibold text-[var(--text-primary)]">{container.name}</span>
          <StatusBadge status={container.state} />
        </div>
        <div class="mb-1.5 truncate font-mono text-[11px] text-[var(--text-muted)]">{container.image}</div>
        {#if container.command.length > 0}
          <div class="mb-1 truncate font-mono text-[11px] text-[var(--text-dimmed)]">
            $ {container.command.join(" ")}{container.args.length > 0 ? ` ${container.args.join(" ")}` : ""}
          </div>
        {/if}
        {#if container.restartCount > 0}
          <div class="mt-2 text-[11px] text-[var(--status-pending)]">
            {container.restartCount} restart{container.restartCount !== 1 ? "s" : ""}
          </div>
        {/if}
      </div>
    {/each}
  </CollapsibleCard>
{/if}
