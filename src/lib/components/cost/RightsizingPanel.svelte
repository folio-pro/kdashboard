<script lang="ts">
  import { Badge, Button, SearchField } from "$lib/components/ui";
  import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "$lib/components/ui/dialog";
  import { ScrollArea } from "$lib/components/ui/scroll-area";
  import { Scaling, ChevronDown, ChevronRight, Wand2 } from "lucide-svelte";
  import { rightsizingStore } from "$lib/stores/rightsizing.svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { toastStore } from "$lib/stores/toast.svelte";
  import { invoke } from "$lib/ipc/core";
  import { openRelatedResourceTab } from "$lib/actions/navigation";
  import { formatCpu, formatBytes } from "$lib/stores/metrics.logic";
  import { cn } from "$lib/utils";
  import type { RightsizingVerdict, WorkloadRightsizing } from "$lib/types";
  import { filterWorkloads, formatSaving, rightsizingPatchYaml, usageShare, verdictLabel, type RightsizingFilter } from "./rightsizing.logic";

  let overview = $derived(rightsizingStore.overview);
  let filter = $state<RightsizingFilter>("all");
  let text = $state("");
  let rows = $derived(overview ? filterWorkloads(overview.workloads, filter, text) : []);
  let expanded = $state<Set<string>>(new Set());
  let patchFor = $state<WorkloadRightsizing | null>(null);
  let patchYaml = $derived(patchFor ? rightsizingPatchYaml(patchFor) : null);
  let applying = $state(false);

  const VERDICT_TONE: Record<RightsizingVerdict, "success" | "warning" | "error" | "muted" | "info"> = {
    over: "warning",
    under: "error",
    ok: "success",
    "no-request": "info",
    "no-data": "muted",
  };

  function toggle(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id); else next.add(id);
    expanded = next;
  }
  function resourceTypeFor(kind: string): string {
    return { Deployment: "deployments", StatefulSet: "statefulsets", DaemonSet: "daemonsets", Job: "jobs", Pod: "pods" }[kind] ?? "pods";
  }
  async function applyPatch() {
    if (!patchFor || !patchYaml) return;
    applying = true;
    try {
      await invoke("apply_yaml", { yaml: patchYaml });
      toastStore.success("Requests updated", `${patchFor.kind}/${patchFor.name} — the rollout will pick up the new requests`);
      patchFor = null;
      rightsizingStore.loadRightsizing(k8sStore.currentNamespace);
    } catch (err) {
      toastStore.error("Apply failed", String(err));
    } finally {
      applying = false;
    }
  }
  function barColor(share: number | null): string {
    if (share === null) return "var(--text-muted)";
    if (share > 90) return "var(--status-failed)";
    if (share < 50) return "var(--status-pending)";
    return "var(--accent)";
  }
</script>

{#if rightsizingStore.isLoading && !overview}
  <div class="flex h-full items-center justify-center text-[12px] text-[var(--text-muted)]">Reading requests and usage…</div>
{:else if rightsizingStore.error}
  <div class="flex h-full items-center justify-center text-[12px] text-[var(--status-failed)]">{rightsizingStore.error}</div>
{:else if overview}
  <ScrollArea class="h-full">
    <div class="flex flex-col gap-4 p-4" data-testid="rightsizing">
      <!-- Summary -->
      <div class="grid grid-cols-4 gap-3">
        <div class="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
          <div class="text-[12px] text-[var(--text-muted)]">Potential saving</div>
          <div class="mt-1 font-mono text-[18px] font-semibold text-[var(--text-primary)]" data-testid="rightsizing-saving">{formatSaving(overview.total_saving_monthly)}<span class="text-[12px] font-normal text-[var(--text-muted)]">/mo</span></div>
          <div class="text-[11px] text-[var(--text-muted)]">if recommendations were applied</div>
        </div>
        <div class="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
          <div class="text-[12px] text-[var(--text-muted)]">Over-provisioned</div>
          <div class="mt-1 font-mono text-[18px] font-semibold text-[var(--status-pending)]">{overview.over_count}</div>
          <div class="text-[11px] text-[var(--text-muted)]">workloads requesting &gt; 1.5× what they use</div>
        </div>
        <div class="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
          <div class="text-[12px] text-[var(--text-muted)]">Under-provisioned</div>
          <div class="mt-1 font-mono text-[18px] font-semibold text-[var(--status-failed)]">{overview.under_count}</div>
          <div class="text-[11px] text-[var(--text-muted)]">using &gt; 90 % of their request — throttling / OOM risk</div>
        </div>
        <div class="rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3">
          <div class="text-[12px] text-[var(--text-muted)]">Usage source</div>
          <div class="mt-1 text-[13px] font-medium text-[var(--text-primary)]">{overview.usage_source === "none" ? "none" : overview.usage_source}</div>
          <div class="text-[11px] text-[var(--text-muted)]">
            {#if overview.usage_source === "prometheus-p95-7d"}P95 over the last 7 days{:else if overview.usage_source === "metrics-server"}one snapshot — point Settings at a Prometheus for a 7-day P95{:else}no metrics-server or Prometheus — requests only{/if}
          </div>
        </div>
      </div>

      <!-- Filters -->
      <div class="flex items-center gap-2">
        <div class="flex gap-0.5 rounded-md bg-[var(--bg-tertiary)] p-0.5 text-[11px]">
          {#each [["all", "All"], ["over", "Over"], ["under", "Under"], ["ok", "Right-sized"]] as [value, label] (value)}
            <button type="button" class={cn("rounded-sm px-2 py-0.5", filter === value ? "bg-[var(--bg-secondary)] text-[var(--text-primary)]" : "text-[var(--text-muted)]")} onclick={() => (filter = value as RightsizingFilter)} data-testid={`rightsizing-filter-${value}`}>{label}</button>
          {/each}
        </div>
        <SearchField value={text} ariaLabel="Filter workloads" placeholder="Filter by workload or namespace" oninput={(e: Event) => { text = (e.target as HTMLInputElement).value; }} class="w-[260px]" />
        <span class="ml-auto text-[11px] text-[var(--text-muted)]">{rows.length} of {overview.workloads.length} workloads · rates ${overview.cpu_rate_per_core_hour.toFixed(4)}/core/h, ${overview.memory_rate_per_gb_hour.toFixed(4)}/GB/h</span>
      </div>

      <!-- Rows -->
      <div class="overflow-hidden rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)]">
        <div class="grid grid-cols-[20px_minmax(0,1.6fr)_70px_minmax(0,1fr)_minmax(0,1fr)_130px_90px_90px] items-center gap-3 bg-[var(--table-header-bg)] px-3 py-1.5 text-[11px] text-[var(--text-muted)]">
          <span></span><span>Workload</span><span class="text-right">Pods</span><span>CPU request → recommended</span><span>Memory request → recommended</span><span>Verdict</span><span class="text-right">Δ / month</span><span></span>
        </div>
        {#if rows.length === 0}
          <p class="px-3 py-6 text-center text-[12px] text-[var(--text-muted)]">No workload matches.</p>
        {/if}
        {#each rows as w (w.id)}
          {@const open = expanded.has(w.id)}
          {@const first = w.containers[0]}
          {@const patchable = !!rightsizingPatchYaml(w)}
          <div class="border-t border-[var(--border-color)]">
            <div class="grid grid-cols-[20px_minmax(0,1.6fr)_70px_minmax(0,1fr)_minmax(0,1fr)_130px_90px_90px] items-center gap-3 px-3 py-2 hover:bg-[var(--table-row-hover)]" data-testid="rightsizing-row">
              <button type="button" class="text-[var(--text-muted)]" onclick={() => toggle(w.id)} aria-label={open ? "Collapse" : "Expand"}>
                {#if open}<ChevronDown class="h-3.5 w-3.5" />{:else}<ChevronRight class="h-3.5 w-3.5" />{/if}
              </button>
              <button type="button" class="flex min-w-0 flex-col text-left" onclick={() => void openRelatedResourceTab(resourceTypeFor(w.kind), w.name, w.namespace)}>
                <span class="truncate font-mono text-[12px] text-[var(--text-primary)]">{w.name}</span>
                <span class="truncate text-[11px] text-[var(--text-muted)]">{w.kind.toLowerCase()} · {w.namespace}{w.containers.length > 1 ? ` · ${w.containers.length} containers` : ""}</span>
              </button>
              <span class="text-right font-mono text-[12px] text-[var(--text-secondary)]">{w.replicas}</span>
              <span class="flex flex-col gap-1">
                <span class="font-mono text-[11px] text-[var(--text-secondary)]">{first?.cpu_request === null ? "—" : formatCpu(first?.cpu_request ?? 0)} → <span class="text-[var(--text-primary)]">{first?.cpu_recommended === null ? "—" : formatCpu(first?.cpu_recommended ?? 0)}</span>{w.containers.length > 1 ? " …" : ""}</span>
                {#if first}{@const s = usageShare(first, "cpu")}<span class="h-1 rounded-full bg-[var(--bg-tertiary)]"><span class="block h-1 rounded-full" style="width: {Math.min(100, s ?? 0)}%; background: {barColor(s)}"></span></span>{/if}
              </span>
              <span class="flex flex-col gap-1">
                <span class="font-mono text-[11px] text-[var(--text-secondary)]">{first?.memory_request === null ? "—" : formatBytes(first?.memory_request ?? 0)} → <span class="text-[var(--text-primary)]">{first?.memory_recommended === null ? "—" : formatBytes(first?.memory_recommended ?? 0)}</span>{w.containers.length > 1 ? " …" : ""}</span>
                {#if first}{@const s = usageShare(first, "memory")}<span class="h-1 rounded-full bg-[var(--bg-tertiary)]"><span class="block h-1 rounded-full" style="width: {Math.min(100, s ?? 0)}%; background: {barColor(s)}"></span></span>{/if}
              </span>
              <span><Badge tone={VERDICT_TONE[w.verdict]}>{verdictLabel(w.verdict)}</Badge></span>
              <span class={cn("text-right font-mono text-[12px]", w.saving_monthly > 0.5 ? "text-[var(--status-running)]" : w.saving_monthly < -0.5 ? "text-[var(--status-failed)]" : "text-[var(--text-muted)]")}>{w.saving_monthly > 0.5 ? "+" : ""}{formatSaving(w.saving_monthly)}</span>
              <span class="text-right">
                {#if patchable}
                  <Button size="sm" variant="outline" onclick={() => (patchFor = w)} data-testid="rightsizing-apply"><Wand2 class="h-3 w-3" /> Apply…</Button>
                {/if}
              </span>
            </div>
            {#if open}
              <div class="border-t border-[var(--border-color)]/60 bg-[var(--bg-primary)]/40 px-3 py-2">
                <table class="w-full text-[11px]">
                  <thead class="text-[var(--text-muted)]">
                    <tr><th class="py-1 text-left font-medium">Container</th><th class="py-1 text-right font-medium">CPU req</th><th class="py-1 text-right font-medium">CPU use</th><th class="py-1 text-right font-medium">CPU rec</th><th class="py-1 text-left font-medium">&nbsp;</th><th class="py-1 text-right font-medium">Mem req</th><th class="py-1 text-right font-medium">Mem use</th><th class="py-1 text-right font-medium">Mem rec</th><th class="py-1 text-left font-medium">&nbsp;</th></tr>
                  </thead>
                  <tbody>
                    {#each w.containers as c (c.container)}
                      <tr class="border-t border-[var(--border-color)]/40 font-mono text-[var(--text-secondary)]">
                        <td class="py-1 text-[var(--text-primary)]">{c.container}</td>
                        <td class="py-1 text-right">{c.cpu_request === null ? "—" : formatCpu(c.cpu_request)}</td>
                        <td class="py-1 text-right">{c.cpu_usage === null ? "—" : formatCpu(c.cpu_usage)}</td>
                        <td class="py-1 text-right text-[var(--text-primary)]">{c.cpu_recommended === null ? "—" : formatCpu(c.cpu_recommended)}</td>
                        <td class="py-1 pl-2"><Badge tone={VERDICT_TONE[c.cpu_verdict]}>{verdictLabel(c.cpu_verdict)}</Badge></td>
                        <td class="py-1 text-right">{c.memory_request === null ? "—" : formatBytes(c.memory_request)}</td>
                        <td class="py-1 text-right">{c.memory_usage === null ? "—" : formatBytes(c.memory_usage)}</td>
                        <td class="py-1 text-right text-[var(--text-primary)]">{c.memory_recommended === null ? "—" : formatBytes(c.memory_recommended)}</td>
                        <td class="py-1 pl-2"><Badge tone={VERDICT_TONE[c.memory_verdict]}>{verdictLabel(c.memory_verdict)}</Badge></td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}
          </div>
        {/each}
      </div>
      <p class="text-[11px] text-[var(--text-muted)]">Recommendations are usage × 1.3 (CPU) / × 1.25 (memory), rounded up. Limits are left alone. Review before applying: a 7-day window misses monthly peaks.</p>
    </div>
  </ScrollArea>
{/if}

<Dialog open={patchFor !== null} onOpenChange={(v) => { if (!v) patchFor = null; }}>
  <DialogContent class="sm:max-w-[640px]">
    <DialogHeader>
      <div class="flex items-center gap-3">
        <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/10"><Scaling class="h-4 w-4 text-[var(--accent)]" /></div>
        <div class="flex flex-col gap-1">
          <DialogTitle>Apply recommended requests?</DialogTitle>
          <DialogDescription class="text-[12px] text-[var(--text-muted)]">
            Server-side apply of the requests below to <span class="font-mono text-[var(--text-secondary)]">{patchFor?.kind}/{patchFor?.name}</span> in <span class="font-mono text-[var(--text-secondary)]">{patchFor?.namespace}</span> ({k8sStore.currentContext}). The controller rolls the pods.
          </DialogDescription>
        </div>
      </div>
    </DialogHeader>
    <pre class="mt-3 max-h-[320px] overflow-auto rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 font-mono text-[11px] leading-relaxed text-[var(--text-primary)]" data-testid="rightsizing-patch">{patchYaml}</pre>
    <DialogFooter>
      <Button variant="outline" size="md" onclick={() => (patchFor = null)} disabled={applying}>Cancel</Button>
      <Button variant="accent" size="md" onclick={applyPatch} disabled={applying} data-testid="rightsizing-confirm">{applying ? "Applying…" : "Apply"}</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
