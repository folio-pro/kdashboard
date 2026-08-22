<script lang="ts">
  import { Badge, Button, CardSection } from "$lib/components/ui";
  import { ShieldCheck } from "lucide-svelte";
  import { netpolStore } from "$lib/stores/netpol.svelte";
  import { openRelatedResourceTab } from "$lib/actions/navigation";
  import type { WorkloadPolicyStatus } from "$lib/types";
  import { describePeer, isolationCounts, unusedPolicies } from "./netpol-layer.logic";

  /** The floating aside of the topology's Policies layer. */
  interface Props {
    selected: WorkloadPolicyStatus | null;
    namespace: string;
  }

  let { selected, namespace }: Props = $props();
  let o = $derived(netpolStore.overview);
  let counts = $derived(o ? isolationCounts(o) : null);
  let unused = $derived(o ? unusedPolicies(o) : []);
</script>

<aside class="absolute right-4 top-4 flex max-h-[calc(100%-2rem)] w-[320px] flex-col text-[12px] shadow-lg" data-testid="netpol-panel">
  <CardSection title="Network policies" icon={ShieldCheck} subtitle={`· ${namespace}`} class="max-h-full">
    {#if netpolStore.isLoading && !o}
      <p class="px-3 py-3 text-[var(--text-muted)]">Reading policies…</p>
    {:else if netpolStore.error}
      <p class="px-3 py-3 text-[var(--status-failed)]">{netpolStore.error}</p>
    {:else if o && counts}
      <div class="flex flex-col gap-2 overflow-y-auto p-3">
        <div class="flex flex-wrap gap-1.5">
          <Badge tone={o.default_deny_ingress ? "success" : "warning"}>{o.default_deny_ingress ? "default-deny ingress" : "no default-deny ingress"}</Badge>
          <Badge tone={o.default_deny_egress ? "success" : "muted"}>{o.default_deny_egress ? "default-deny egress" : "egress open by default"}</Badge>
        </div>
        <div class="grid grid-cols-3 gap-1 text-center text-[11px]">
          <div class="rounded-md border border-[var(--border-color)] p-1.5"><div class="font-mono text-[15px] text-[var(--status-running)]">{counts.isolated}</div>isolated</div>
          <div class="rounded-md border border-[var(--border-color)] p-1.5"><div class="font-mono text-[15px] text-[var(--status-pending)]">{counts.partial}</div>partial</div>
          <div class="rounded-md border border-[var(--border-color)] p-1.5"><div class="font-mono text-[15px] text-[var(--status-failed)]">{counts.open}</div>open</div>
        </div>
        {#if selected}
          <div class="rounded-md border border-[var(--accent)]/40 bg-[var(--bg-primary)]/40 p-2" data-testid="netpol-selected">
            <div class="font-mono text-[var(--text-primary)]">{selected.kind}/{selected.name}</div>
            <div class="mt-1 text-[11px] text-[var(--text-secondary)]"><span class="text-[var(--text-muted)]">ingress:</span> {selected.isolated_ingress ? `from ${describePeer(selected.allowed_from)}${selected.allowed_from.ports.length ? ` on ${selected.allowed_from.ports.join(", ")}` : ""}` : "unrestricted"}</div>
            <div class="text-[11px] text-[var(--text-secondary)]"><span class="text-[var(--text-muted)]">egress:</span> {selected.isolated_egress ? `to ${describePeer(selected.allowed_to)}${selected.allowed_to.ports.length ? ` on ${selected.allowed_to.ports.join(", ")}` : ""}` : "unrestricted"}</div>
            {#if selected.policies.length}<div class="mt-1 text-[11px] text-[var(--text-muted)]">policies: {selected.policies.join(", ")}</div>{/if}
          </div>
        {:else}
          <p class="text-[11px] text-[var(--text-muted)]">Click a workload to see what may reach it. Dashed arrows are flows the policies allow inside this namespace.</p>
        {/if}
        <div class="text-[11px] uppercase tracking-[0.08em] text-[var(--text-muted)]">Policies · {o.policy_count}</div>
        {#if o.policies.length === 0}
          <p class="text-[11px] text-[var(--text-muted)]">None in this namespace — every pod accepts traffic from anywhere.</p>
        {/if}
        {#each o.policies as pol (pol.name)}
          <Button variant="ghost" size="xs" class="w-full justify-start gap-2 px-2" onclick={() => void openRelatedResourceTab("networkpolicies", pol.name, namespace)} data-testid="netpol-policy">
            <span class="min-w-0 flex-1 truncate text-left font-mono text-[var(--text-primary)]">{pol.name}</span>
            <span class="font-mono text-[10px] text-[var(--text-muted)]">{pol.policy_types.map((t) => t[0]).join("")}</span>
            {#if unused.includes(pol.name)}<Badge tone="warning">selects nothing</Badge>{:else}<span class="font-mono text-[10px] text-[var(--text-muted)]">{pol.pod_count} pods</span>{/if}
          </Button>
        {/each}
      </div>
    {/if}
  </CardSection>
</aside>
