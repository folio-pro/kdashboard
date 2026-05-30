<script lang="ts">
  import { Box, Layers } from "lucide-svelte";
  import StatusBadge from "$lib/components/common/StatusBadge.svelte";
  import DetailSection from "./DetailSection.svelte";
  import { getContainerState } from "$lib/utils/k8s-helpers";
  import type { ContainerStatus, SpecContainer } from "./pod-utils";

  interface Props {
    containerStatuses: ContainerStatus[];
    specContainerMap: Map<string, SpecContainer>;
  }

  let { containerStatuses, specContainerMap }: Props = $props();

  type CtrCategory = "running" | "waiting" | "terminated";

  function ctrCategory(state: Record<string, unknown> | undefined): CtrCategory {
    if (state?.running) return "running";
    if (state?.waiting) return "waiting";
    if (state?.terminated) return "terminated";
    return "running";
  }

  // Reference colours: running → blue, waiting → red, terminated → amber.
  function ctrColor(cat: CtrCategory): string {
    if (cat === "running") return "var(--status-succeeded)";
    if (cat === "waiting") return "var(--status-failed)";
    return "var(--status-pending)";
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

{#if containerStatuses.length > 0}
  <DetailSection title="Containers" icon={Layers}>
    {#snippet actions()}
      <span class="font-mono text-[11px] text-[var(--text-dimmed)]">{containerStatuses.length}</span>
    {/snippet}
    <div class="flex flex-col gap-2.5">
      {#each containerStatuses as c}
        {@const spec = specContainerMap.get(c.name)}
        {@const cat = ctrCategory(c.state)}
        {@const color = ctrColor(cat)}
        <div class="rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3.5">
          <!-- head -->
          <div class="flex items-center gap-3">
            <span
              class="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md"
              style:background-color={`color-mix(in srgb, ${color} 16%, transparent)`}
              style:color
            >
              <Box class="h-[15px] w-[15px]" />
            </span>
            <div class="min-w-0 flex-1">
              <div class="text-[13px] font-medium text-[var(--text-primary)]">{c.name}</div>
              <div class="truncate font-mono text-[11.5px] text-[var(--text-muted)]" title={c.image}>{c.image}</div>
            </div>
            <StatusBadge status={getContainerState(c.state ?? {})} />
            {#if c.restartCount > 0}
              <span
                class="shrink-0 text-right font-mono text-[12px]"
                style:color={c.restartCount > 5 ? "var(--status-failed)" : "var(--status-pending)"}
                title="Restarts"
              >↻ {c.restartCount}</span>
            {/if}
          </div>
          <!-- grid -->
          <div class="mt-3.5 grid gap-x-6 gap-y-3 border-t border-[var(--border-color)] pt-3.5 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]">
            <div>
              <span class="mb-0.5 block text-[10.5px] text-[var(--text-muted)]">Ports</span>
              <span class="font-mono text-[12.5px] text-[var(--text-primary)]">{ctrPorts(spec)}</span>
            </div>
            <div>
              <span class="mb-0.5 block text-[10.5px] text-[var(--text-muted)]">Mounts</span>
              <span class="font-mono text-[12.5px] text-[var(--text-primary)]">{ctrMounts(spec)}</span>
            </div>
            <div>
              <span class="mb-0.5 block text-[10.5px] text-[var(--text-muted)]">CPU</span>
              <span class="font-mono text-[12.5px] text-[var(--text-primary)]">{ctrRes(spec, "cpu")}</span>
            </div>
            <div>
              <span class="mb-0.5 block text-[10.5px] text-[var(--text-muted)]">Memory</span>
              <span class="font-mono text-[12.5px] text-[var(--text-primary)]">{ctrRes(spec, "memory")}</span>
            </div>
            <div>
              <span class="mb-0.5 block text-[10.5px] text-[var(--text-muted)]">Image Pull</span>
              <span class="font-mono text-[12.5px] text-[var(--text-primary)]">{ctrImagePull(spec)}</span>
            </div>
            <div>
              <span class="mb-0.5 block text-[10.5px] text-[var(--text-muted)]">Env</span>
              <span class="font-mono text-[12.5px] text-[var(--text-primary)]">{ctrEnvCount(spec)} vars</span>
            </div>
          </div>
        </div>
      {/each}
    </div>
  </DetailSection>
{/if}
