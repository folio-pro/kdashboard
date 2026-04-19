<script lang="ts">
  import CollapsibleCard from "./CollapsibleCard.svelte";

  interface Props {
    spec: Record<string, unknown>;
  }

  let { spec }: Props = $props();

  type ProbeType = "httpGet" | "tcpSocket" | "exec" | "grpc";

  interface ProbeInfo {
    containerName: string;
    probeName: string;
    type: ProbeType | "unknown";
    detail: string;
    initialDelaySeconds: number;
    periodSeconds: number;
    timeoutSeconds: number;
    successThreshold: number;
    failureThreshold: number;
  }

  const probeTypeColors: Record<string, string> = {
    httpGet: "var(--accent)",
    tcpSocket: "var(--status-running)",
    exec: "var(--status-pending)",
    grpc: "#a78bfa",
  };

  function extractProbeType(probe: Record<string, unknown>): { type: ProbeType | "unknown"; detail: string } {
    if (probe.httpGet) {
      const h = probe.httpGet as Record<string, unknown>;
      const path = h.path ?? "/";
      const port = h.port ?? "?";
      return { type: "httpGet", detail: `${path} :${port}` };
    }
    if (probe.tcpSocket) {
      const t = probe.tcpSocket as Record<string, unknown>;
      return { type: "tcpSocket", detail: `:${t.port ?? "?"}` };
    }
    if (probe.exec) {
      const e = probe.exec as Record<string, unknown>;
      const cmd = (e.command as string[]) ?? [];
      return { type: "exec", detail: cmd.join(" ") };
    }
    if (probe.grpc) {
      const g = probe.grpc as Record<string, unknown>;
      return { type: "grpc", detail: `:${g.port ?? "?"}` };
    }
    return { type: "unknown", detail: "" };
  }

  function extractProbes(containers: Array<Record<string, unknown>>, source: string): ProbeInfo[] {
    const probes: ProbeInfo[] = [];
    for (const c of containers) {
      const name = (c.name as string) ?? "unknown";
      for (const probeName of ["livenessProbe", "readinessProbe", "startupProbe"]) {
        const probe = c[probeName] as Record<string, unknown> | undefined;
        if (!probe) continue;
        const { type, detail } = extractProbeType(probe);
        probes.push({
          containerName: `${name}${source === "init" ? " (init)" : ""}`,
          probeName: probeName.replace("Probe", ""),
          type,
          detail,
          initialDelaySeconds: (probe.initialDelaySeconds as number) ?? 0,
          periodSeconds: (probe.periodSeconds as number) ?? 10,
          timeoutSeconds: (probe.timeoutSeconds as number) ?? 1,
          successThreshold: (probe.successThreshold as number) ?? 1,
          failureThreshold: (probe.failureThreshold as number) ?? 3,
        });
      }
    }
    return probes;
  }

  let allProbes = $derived.by(() => {
    const containers = (spec.containers as Array<Record<string, unknown>>) ?? [];
    const initContainers = (spec.initContainers as Array<Record<string, unknown>>) ?? [];
    return [...extractProbes(containers, "main"), ...extractProbes(initContainers, "init")];
  });

  let hasContent = $derived(allProbes.length > 0);
</script>

{#if hasContent}
  <CollapsibleCard title="Health Probes" count={allProbes.length}>
    {#each allProbes as probe, i}
      <div class="border-t border-[var(--border-hover)] px-5 py-4">
        <div class="mb-3 flex items-center gap-2">
          <span class="text-[12px] font-semibold text-[var(--text-primary)]">{probe.containerName}</span>
          <span
            class="rounded-full px-2 py-0.5 text-[10px] font-medium"
            style="color: {probeTypeColors[probe.type] ?? 'var(--text-dimmed)'}; background-color: color-mix(in srgb, {probeTypeColors[probe.type] ?? 'var(--text-dimmed)'} 12%, transparent);"
          >
            {probe.type}
          </span>
          <span class="text-[11px] text-[var(--text-muted)]">{probe.probeName}</span>
        </div>
        {#if probe.detail}
          <div class="mb-2.5 truncate font-mono text-[11px] text-[var(--text-muted)]">{probe.detail}</div>
        {/if}
        <div class="grid grid-cols-5 gap-2">
          <div class="flex flex-col gap-0.5">
            <span class="text-[10px] text-[var(--text-dimmed)]">delay</span>
            <span class="font-mono text-[11px] text-[var(--text-primary)]">{probe.initialDelaySeconds}s</span>
          </div>
          <div class="flex flex-col gap-0.5">
            <span class="text-[10px] text-[var(--text-dimmed)]">period</span>
            <span class="font-mono text-[11px] text-[var(--text-primary)]">{probe.periodSeconds}s</span>
          </div>
          <div class="flex flex-col gap-0.5">
            <span class="text-[10px] text-[var(--text-dimmed)]">timeout</span>
            <span class="font-mono text-[11px] text-[var(--text-primary)]">{probe.timeoutSeconds}s</span>
          </div>
          <div class="flex flex-col gap-0.5">
            <span class="text-[10px] text-[var(--text-dimmed)]">success</span>
            <span class="font-mono text-[11px] text-[var(--text-primary)]">{probe.successThreshold}</span>
          </div>
          <div class="flex flex-col gap-0.5">
            <span class="text-[10px] text-[var(--text-dimmed)]">failure</span>
            <span class="font-mono text-[11px] text-[var(--text-primary)]">{probe.failureThreshold}</span>
          </div>
        </div>
      </div>
    {/each}
  </CollapsibleCard>
{/if}
