<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { History } from "lucide-svelte";
  import { Button } from "$lib/components/ui/button";
  import ConfirmDialog from "$lib/components/common/ConfirmDialog.svelte";
  import { rollbackDeployment } from "$lib/actions/registry";
  import { toastStore } from "$lib/stores/toast.svelte";
  import { formatAge, formatTimestamp } from "$lib/utils/age";
  import type { Resource } from "$lib/types";

  interface RevisionInfo {
    revision: number;
    name: string;
    created_at: string | null;
    images: string[];
    replicas: number;
    is_current: boolean;
  }

  interface Props {
    resource: Resource;
  }

  let { resource }: Props = $props();

  let revisions = $state<RevisionInfo[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let pendingRevision = $state<RevisionInfo | null>(null);
  let rollbackInFlight = $state(false);

  let resourceKey = $derived(
    `${resource.metadata.namespace ?? ""}:${resource.metadata.name}`,
  );

  function fetchRevisions(): Promise<RevisionInfo[]> {
    return invoke<RevisionInfo[]>("list_deployment_revisions", {
      name: resource.metadata.name,
      namespace: resource.metadata.namespace ?? "",
    });
  }

  $effect(() => {
    const key = resourceKey;
    let cancelled = false;

    // Dismiss any pending rollback so confirmRollback can't target a deployment
    // different from the one the user originally opened the dialog on.
    pendingRevision = null;

    loading = true;
    error = null;
    fetchRevisions()
      .then((result) => {
        if (!cancelled) revisions = result;
      })
      .catch((err) => {
        if (!cancelled) {
          error = String(err);
          revisions = [];
        }
      })
      .finally(() => {
        if (!cancelled) loading = false;
      });

    return () => {
      cancelled = true;
      void key;
    };
  });

  async function confirmRollback() {
    if (!pendingRevision) return;
    const target = pendingRevision;
    rollbackInFlight = true;
    try {
      await rollbackDeployment(resource, target.revision);
      revisions = await fetchRevisions();
    } catch (err) {
      toastStore.error("Rollback failed", String(err));
    } finally {
      rollbackInFlight = false;
      pendingRevision = null;
    }
  }
</script>

<div class="overflow-hidden rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]">
  <div class="flex items-center justify-between px-5 py-4">
    <div class="flex items-center gap-2">
      <History class="h-3.5 w-3.5 text-[var(--text-muted)]" />
      <h3 class="text-[13px] font-semibold text-[var(--text-primary)]">Revision History</h3>
    </div>
    <span class="text-[11px] text-[var(--text-muted)]">
      {#if loading}
        loading…
      {:else}
        {revisions.length} {revisions.length === 1 ? "revision" : "revisions"}
      {/if}
    </span>
  </div>

  {#if error}
    <div class="border-t border-[var(--border-hover)] px-5 py-4">
      <span class="text-xs text-[var(--status-failed)]">Failed to load revisions: {error}</span>
    </div>
  {:else if revisions.length > 0}
    <div class="border-t border-[var(--border-hover)]">
      <table class="w-full">
        <thead>
          <tr class="border-b border-[var(--border-hover)]">
            <th class="px-4 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Rev</th>
            <th class="px-4 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Images</th>
            <th class="px-4 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Age</th>
            <th class="px-4 py-2 text-right text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]"></th>
          </tr>
        </thead>
        <tbody>
          {#each revisions as rev (rev.name)}
            <tr class="border-b border-[var(--border-hover)] last:border-b-0">
              <td class="px-4 py-2.5 text-[12px] font-mono font-medium text-[var(--text-primary)]">
                <div class="flex items-center gap-2">
                  <span>#{rev.revision}</span>
                  {#if rev.is_current}
                    <span class="rounded bg-[var(--status-running)]/15 px-1.5 py-0.5 text-[10px] font-medium text-[var(--status-running)]">
                      current
                    </span>
                  {/if}
                </div>
              </td>
              <td class="px-4 py-2.5 text-[11px] text-[var(--text-secondary)]">
                {#if rev.images.length === 0}
                  <span class="text-[var(--text-muted)]">—</span>
                {:else}
                  <div class="flex flex-col gap-0.5">
                    {#each rev.images as image}
                      <span class="break-all font-mono">{image}</span>
                    {/each}
                  </div>
                {/if}
              </td>
              <td
                class="px-4 py-2.5 text-[12px] text-[var(--text-muted)]"
                title={rev.created_at ? formatTimestamp(rev.created_at) : ""}
              >
                {rev.created_at ? formatAge(rev.created_at) : "—"}
              </td>
              <td class="px-4 py-2.5 text-right">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={rev.is_current || rollbackInFlight}
                  onclick={() => (pendingRevision = rev)}
                  title={rev.is_current ? "Already the current revision" : `Rollback to revision ${rev.revision}`}
                >
                  Rollback
                </Button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else if !loading}
    <div class="border-t border-[var(--border-hover)] px-5 py-4">
      <span class="text-xs text-[var(--text-muted)]">No revisions found</span>
    </div>
  {/if}
</div>

<ConfirmDialog
  open={pendingRevision !== null}
  title="Rollback deployment"
  description={pendingRevision
    ? `Rollback ${resource.metadata.name} to revision #${pendingRevision.revision}? Running pods will be replaced with the template from this revision.`
    : ""}
  confirmLabel={rollbackInFlight ? "Rolling back..." : "Rollback"}
  variant="destructive"
  onconfirm={confirmRollback}
  oncancel={() => (pendingRevision = null)}
/>
