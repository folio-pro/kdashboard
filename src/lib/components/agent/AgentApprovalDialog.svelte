<script lang="ts">
  import { ShieldAlert } from "lucide-svelte";
  import { Dialog, DialogContent } from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { agentStore } from "$lib/stores/agent.svelte";

  // Requests queue in the store; the dialog always shows the oldest one.
  // The broker in main serializes tool calls, but a queue also survives a
  // burst (e.g. approval disabled mid-flight, or a reconnecting agent).
  const current = $derived(agentStore.approvals[0] ?? null);

  // bits-ui drives `open` through onOpenChange on Escape/overlay dismissal —
  // a dismissal without a verdict is a denial (deny is the safe default).
  let open = $state(false);
  $effect(() => {
    open = current !== null;
  });

  function handleOpenChange(next: boolean): void {
    if (!next && current) agentStore.respondApproval(current.id, false);
  }

  function resourceLabel(r: NonNullable<typeof current>["resource"]): string {
    const ns = r.namespace ? `${r.namespace}/` : "";
    const container = r.container ? ` · container ${r.container}` : "";
    return `${r.kind} ${ns}${r.name}${container}`;
  }
</script>

{#if current}
  <Dialog bind:open onOpenChange={handleOpenChange}>
    <DialogContent class="sm:max-w-[420px]" aria-labelledby="agent-approval-title" aria-describedby="agent-approval-desc">
      <div class="flex flex-col gap-4 p-1">
        <div class="flex items-start gap-3">
          <div class="mt-0.5 rounded-md bg-[var(--status-warning)]/15 p-2">
            <ShieldAlert class="h-4 w-4 text-[var(--status-warning)]" />
          </div>
          <div>
            <h3 id="agent-approval-title" class="text-[13px] font-semibold text-[var(--text-primary)]">
              Agent requests a change
            </h3>
            <p id="agent-approval-desc" class="mt-1 text-[11px] text-[var(--text-muted)]">
              The AI agent wants to run <span class="font-mono">{current.tool}</span> on
              {#if current.context}<span class="font-mono">{current.context}</span>{:else}your cluster{/if}.
            </p>
          </div>
        </div>

        <div class="rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2">
          <p class="font-mono text-[12px] text-[var(--text-primary)]">{resourceLabel(current.resource)}</p>
          <ul class="mt-1 space-y-0.5">
            {#each current.changes as change (change)}
              <li class="font-mono text-[11px] text-[var(--text-secondary)]">{change}</li>
            {/each}
          </ul>
        </div>

        {#if agentStore.approvals.length > 1}
          <p class="text-[11px] text-[var(--text-muted)]">
            +{agentStore.approvals.length - 1} more pending
          </p>
        {/if}

        <div class="flex justify-end gap-2">
          <Button variant="outline" size="md" onclick={() => agentStore.respondApproval(current.id, false)}>
            Deny
          </Button>
          <Button variant="solid-tone" tone="success" size="md" onclick={() => agentStore.respondApproval(current.id, true)}>
            Approve
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
{/if}
