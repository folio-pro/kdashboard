<script lang="ts">
  // CPU + memory for one pod: the instantaneous value always (metrics-server),
  // plus an hour of history when a Prometheus is configured in Settings.

  import type { Resource } from "$lib/types";
  import CollapsibleCard from "./CollapsibleCard.svelte";
  import UsageSparkline from "./UsageSparkline.svelte";
  import { metricsStore } from "$lib/stores/metrics.svelte";
  import { prometheusHistory, PROMETHEUS_HINT } from "$lib/stores/prometheus-series.svelte";
  import { cpuCell, memoryCell, formatCpu, formatBytes } from "$lib/stores/metrics.logic";

  let { resource }: { resource: Resource } = $props();

  const WINDOW_MINUTES = 60;

  let namespace = $derived(resource.metadata.namespace ?? "");
  let name = $derived(resource.metadata.name);

  let usage = $derived(metricsStore.getPodUsage(namespace, name));
  let cpu = $derived(cpuCell(resource, usage));
  let memory = $derived(memoryCell(resource, usage));

  // Pull the history once per pod. cadvisor's namespace/pod labels are the one
  // pair every Prometheus scraping kubelets agrees on; container!="" drops the
  // per-pod rollup so the sum is not counted twice.
  const history = prometheusHistory(() => {
    const selector = `namespace="${namespace}",pod="${name}",container!=""`;
    return [
      `sum(rate(container_cpu_usage_seconds_total{${selector}}[5m]))`,
      `sum(container_memory_working_set_bytes{${selector}})`,
    ];
  }, WINDOW_MINUTES);

  // Keep the instant values fresh while the panel is open.
  $effect(() => {
    void namespace;
    void name;
    void metricsStore.loadPodMetrics(namespace || null);
  });
</script>

<CollapsibleCard title="Usage" defaultExpanded={true}>
  <!-- No divider: the card has a single section, so a border under the title
       would split one block in two. Cards with repeated sections (probes,
       security context) keep their per-section borders. -->
  <div class="grid grid-cols-2 gap-6 px-5 pb-1">
    <div class="flex flex-col gap-1">
      <span class="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">CPU</span>
      {#if cpu}
        <span class="font-mono text-[12px] tabular-nums text-[var(--text-primary)]">{cpu.label}</span>
        <span class="font-mono text-[12px] text-[var(--text-muted)]">
          {cpu.requestLabel ? `request ${cpu.requestLabel}` : "no request"} ·
          {cpu.limitLabel ? `limit ${cpu.limitLabel}` : "no limit"}
          {cpu.percent !== null ? ` · ${cpu.percent}% of the ${cpu.basis}` : ""}
        </span>
      {:else if metricsStore.podMetricsAvailable}
        <span class="text-[12px] text-[var(--text-muted)]">Waiting for the next scrape…</span>
      {:else}
        <span class="text-[12px] text-[var(--text-muted)]" title={metricsStore.unavailableReason}>No metrics-server</span>
      {/if}
      {#if history.configured}
        <UsageSparkline samples={history.series[0] ?? []} format={formatCpu} />
      {/if}
    </div>

    <div class="flex flex-col gap-1">
      <span class="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Memory</span>
      {#if memory}
        <span class="font-mono text-[12px] tabular-nums text-[var(--text-primary)]">{memory.label}</span>
        <span class="font-mono text-[12px] text-[var(--text-muted)]">
          {memory.requestLabel ? `request ${memory.requestLabel}` : "no request"} ·
          {memory.limitLabel ? `limit ${memory.limitLabel}` : "no limit"}
          {memory.percent !== null ? ` · ${memory.percent}% of the ${memory.basis}` : ""}
        </span>
      {:else if metricsStore.podMetricsAvailable}
        <span class="text-[12px] text-[var(--text-muted)]">Waiting for the next scrape…</span>
      {:else}
        <span class="text-[12px] text-[var(--text-muted)]" title={metricsStore.unavailableReason}>No metrics-server</span>
      {/if}
      {#if history.configured}
        <UsageSparkline samples={history.series[1] ?? []} format={formatBytes} color="var(--status-running)" />
      {/if}
    </div>
  </div>

  {#if !history.configured}
    <p class="px-5 pb-3 text-[10px] text-[var(--text-muted)]">{PROMETHEUS_HINT}</p>
  {:else if history.error}
    <p class="px-5 pb-3 text-[10px] text-[var(--status-failed)]">{history.error}</p>
  {/if}
</CollapsibleCard>
