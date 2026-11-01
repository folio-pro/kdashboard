<script lang="ts">
  import StatusBadge from "$lib/components/common/StatusBadge.svelte";
  import { isQuietStatus, statusCategory, statusColor } from "$lib/components/table/status-category";
  import DetailSection from "./DetailSection.svelte";
  import { getContainerState } from "$lib/utils/k8s-helpers";
  import type { ContainerStatus, SpecContainer } from "./pod-utils";

  interface Props {
    containerStatuses: ContainerStatus[];
    specContainerMap: Map<string, SpecContainer>;
  }

  let { containerStatuses, specContainerMap }: Props = $props();

  /** The tick is quiet while the container is, and otherwise takes the state's colour. */
  function ctrColor(state: string): string {
    const category = statusCategory(state);
    return isQuietStatus(category) ? "var(--text-muted)" : statusColor(category);
  }

  function ctrPorts(c: SpecContainer | undefined): string {
    const ports = c?.ports ?? [];
    if (ports.length === 0) return "—";
    return ports.map((p) => `${p.containerPort}/${p.protocol ?? "TCP"}`).join(", ");
  }

  function ctrMounts(c: SpecContainer | undefined): string {
    // volumeMounts isn't in the narrow SpecContainer type; read it loosely.
    const mounts = (c as unknown as { volumeMounts?: Array<{ name: string }> })?.volumeMounts ?? [];
    if (mounts.length === 0) return "—";
    return mounts.map((m) => m.name).join(", ");
  }

  function ctrRes(c: SpecContainer | undefined, key: "cpu" | "memory"): string {
    const req = c?.resources?.requests?.[key];
    const lim = c?.resources?.limits?.[key];
    if (!req && !lim) return "—";
    return `${req ?? "—"} / ${lim ?? "—"}`;
  }

  function ctrImagePull(c: SpecContainer | undefined): string {
    return (c as unknown as { imagePullPolicy?: string })?.imagePullPolicy ?? "IfNotPresent";
  }

  function ctrEnvCount(c: SpecContainer | undefined): number {
    return (c?.env?.length ?? 0) + (c?.envFrom?.length ?? 0);
  }
</script>

{#snippet field(label: string, value: string)}
  <dt class="text-[12px] text-[var(--text-muted)]">{label}</dt>
  <dd class="min-w-0 truncate font-mono text-[12px] text-[var(--text-primary)]" title={value}>{value}</dd>
{/snippet}

{#if containerStatuses.length > 0}
  <DetailSection title="Containers">
    {#snippet actions()}
      <span class="font-mono text-[11px] text-[var(--text-muted)]">{containerStatuses.length}</span>
    {/snippet}
    <div class="flex flex-col gap-2">
      {#each containerStatuses as c}
        {@const spec = specContainerMap.get(c.name)}
        {@const state = getContainerState(c.state ?? {})}
        <div class="flex flex-col gap-3 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
          <div class="flex items-center gap-2">
            <span class="h-7 w-1 shrink-0 rounded-[1px]" style:background-color={ctrColor(state)}></span>
            <div class="min-w-0 flex-1">
              <div class="text-[12px] font-medium text-[var(--text-primary)]">{c.name}</div>
              <div class="truncate font-mono text-[11px] text-[var(--text-muted)]" title={c.image}>{c.image}</div>
            </div>
            {#if c.restartCount > 0}
              <span
                class="shrink-0 whitespace-nowrap font-mono text-[11px]"
                style:color={c.restartCount > 5 ? "var(--status-failed)" : "var(--status-pending)"}
              >{c.restartCount} {c.restartCount === 1 ? "restart" : "restarts"}</span>
            {/if}
          </div>
          <dl class="grid grid-cols-[96px_minmax(0,1fr)] items-baseline gap-x-2 gap-y-2">
            <dt class="text-[12px] text-[var(--text-muted)]">State</dt>
            <dd class="min-w-0"><StatusBadge status={state} /></dd>
            {@render field("CPU", ctrRes(spec, "cpu"))}
            {@render field("Memory", ctrRes(spec, "memory"))}
            {@render field("Image pull", ctrImagePull(spec))}
            {@render field("Ports", ctrPorts(spec))}
            {@render field("Mounts", ctrMounts(spec))}
            {@render field("Env", `${ctrEnvCount(spec)} vars`)}
          </dl>
        </div>
      {/each}
    </div>
  </DetailSection>
{/if}
