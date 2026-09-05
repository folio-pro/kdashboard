<script lang="ts">
  import { Badge } from "$lib/components/ui";
  import { invoke } from "$lib/ipc/core";
  import { History, GitCompare, X } from "lucide-svelte";
  import { Button } from "$lib/components/ui/button";
  import { loadCodeMirror, type CodeMirrorModules } from "$lib/utils/codemirror-lazy";
  import { getExtensions } from "./codemirror-extensions";
  import type { MergeView as MergeViewType } from "@codemirror/merge";
  import ConfirmDialog from "$lib/components/common/ConfirmDialog.svelte";
  import { rollbackDeployment } from "$lib/actions/registry";
  import { toastStore } from "$lib/stores/toast.svelte";
  import { formatAge, formatTimestamp } from "$lib/utils/age";
  import type { Resource } from "$lib/types";
  import {
    canDiffRevisions,
    diffAgainstCurrent,
    orderDiffPair,
    performRollback,
    resourceKey as deriveResourceKey,
    type RevisionDiff,
    type RevisionInfo,
  } from "./revision-history-card.logic";

  interface Props {
    resource: Resource;
  }

  let { resource }: Props = $props();

  let revisions = $state<RevisionInfo[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let pendingRevision = $state<RevisionInfo | null>(null);
  let rollbackInFlight = $state(false);

  // --- Revision diff ---------------------------------------------------------
  // "Diff" on a row compares it with the current revision; clicking a second
  // row while a diff is open re-targets the pair (older left, newer right).
  let diff = $state<RevisionDiff | null>(null);
  let diffError = $state<string | null>(null);
  let diffContainer: HTMLDivElement | undefined = $state();
  let mergeView: MergeViewType | null = null;
  let cm: CodeMirrorModules | null = null;

  let resourceKey = $derived(deriveResourceKey(resource));
  let diffable = $derived(canDiffRevisions(revisions));

  function destroyMergeView() {
    mergeView?.destroy();
    mergeView = null;
  }

  function closeDiff() {
    destroyMergeView();
    diff = null;
    diffError = null;
  }

  function showDiff(rev: RevisionInfo) {
    if (diff && diff.base.name !== rev.name && diff.head.name !== rev.name) {
      // A diff is open: re-anchor on the revision the user is looking at and
      // compare it with the one they just picked.
      const anchor = diff.head.is_current ? diff.base : diff.head;
      diff = orderDiffPair(anchor, rev);
      return;
    }
    diff = diffAgainstCurrent(revisions, rev);
  }

  $effect(() => {
    const pair = diff;
    const container = diffContainer;
    if (!pair || !container) return;
    let cancelled = false;
    diffError = null;
    void (async () => {
      try {
        if (!cm) cm = await loadCodeMirror();
        if (cancelled) return;
        const modules = cm;
        destroyMergeView();
        const readOnly = [
          ...getExtensions(modules, "", () => {}, true),
          modules.EditorView.editable.of(false),
        ];
        mergeView = new modules.MergeView({
          a: { doc: pair.base.template_yaml ?? "", extensions: readOnly },
          b: { doc: pair.head.template_yaml ?? "", extensions: readOnly },
          parent: container,
          highlightChanges: true,
          gutter: true,
          collapseUnchanged: { margin: 3, minSize: 4 },
        });
        mergeView.dom.style.height = "100%";
        mergeView.dom.style.minHeight = "0";
        mergeView.dom.style.overflowY = "auto";
      } catch (err) {
        if (!cancelled) diffError = String(err);
      }
    })();
    return () => {
      cancelled = true;
    };
  });

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
    closeDiff();

    loading = true;
    error = null;
    fetchRevisions()
      .then((result) => {
        if (!cancelled) revisions = result ?? [];
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
    const outcome = await performRollback(resource, target, {
      rollback: rollbackDeployment,
      fetchRevisions,
      notifyError: (title, detail) => toastStore.error(title, detail),
    });
    if (outcome.ok && outcome.revisions) {
      revisions = outcome.revisions;
    }
    rollbackInFlight = false;
    pendingRevision = null;
  }
</script>

<div class="border-b border-[var(--border-color)]">
  <div class="flex items-center justify-between px-6 py-4">
    <div class="flex items-center gap-2">
      <History class="h-3.5 w-3.5 text-[var(--text-muted)]" />
      <span class="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">Revision History</span>
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
      <span class="text-[12px] text-[var(--status-failed)]">Failed to load revisions: {error}</span>
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
                    <Badge tone="success">
                      current
                    </Badge>
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
                <div class="flex items-center justify-end gap-1.5">
                  {#if diffable}
                    <Button
                      variant={diff && (diff.base.name === rev.name || diff.head.name === rev.name) ? "toolbar" : "ghost"}
                      size="md"
                      disabled={rev.is_current && !diff}
                      onclick={() => showDiff(rev)}
                      title={rev.is_current ? "Current revision — pick another row to diff against it" : `Diff revision ${rev.revision} against the current one`}
                      data-testid="revision-diff"
                    >
                      <GitCompare class="h-3.5 w-3.5" />
                      Diff
                    </Button>
                  {/if}
                  <Button
                    variant="outline"
                    size="md"
                    disabled={rev.is_current || rollbackInFlight}
                    onclick={() => (pendingRevision = rev)}
                    title={rev.is_current ? "Already the current revision" : `Rollback to revision ${rev.revision}`}
                  >
                    Rollback
                  </Button>
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if diff}
      <div class="border-t border-[var(--border-hover)]" data-testid="revision-diff-panel">
        <div class="flex items-center gap-2 px-4 py-2">
          <GitCompare class="h-3.5 w-3.5 text-[var(--text-muted)]" />
          <span class="text-[12px] text-[var(--text-secondary)]">
            Pod template
            <span class="font-mono text-[var(--text-primary)]">#{diff.base.revision}</span>
            <span class="text-[var(--text-muted)]">→</span>
            <span class="font-mono text-[var(--text-primary)]">#{diff.head.revision}</span>
            {#if diff.head.is_current}<span class="text-[var(--text-muted)]">(current)</span>{/if}
          </span>
          <span class="text-[11px] text-[var(--text-muted)]">· click another row's Diff to change the pair</span>
          <div class="flex-1"></div>
          <Button variant="ghost" size="icon-sm" onclick={closeDiff} title="Close diff">
            <X class="h-3.5 w-3.5" />
          </Button>
        </div>
        {#if diffError}
          <div class="px-4 pb-3 text-[12px] text-[var(--status-failed)]">Failed to render diff: {diffError}</div>
        {:else if diff.base.template_yaml === diff.head.template_yaml}
          <div class="px-4 pb-3 text-[12px] text-[var(--text-muted)]">The pod templates are identical — this revision only differed in its pod-template-hash.</div>
        {:else}
          <div class="h-[320px] border-t border-[var(--border-hover)]" bind:this={diffContainer}></div>
        {/if}
      </div>
    {/if}
  {:else if !loading}
    <div class="border-t border-[var(--border-hover)] px-5 py-4">
      <span class="text-[12px] text-[var(--text-muted)]">No revisions found</span>
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
