<script lang="ts">
  import { invoke } from "$lib/ipc/core";
  import { Dialog, DialogContent } from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { SelectMenu } from "$lib/components/ui/select-menu";
  import { FolderOpen, Server } from "lucide-svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import type { Resource } from "$lib/types";
  import { loadCodeMirror, type CodeMirrorModules } from "$lib/utils/codemirror-lazy";
  import { getExtensions } from "./codemirror-extensions";
  import type { MergeView as MergeViewType } from "@codemirror/merge";

  let { open = $bindable(false), resource }: {
    open: boolean;
    resource: Resource;
  } = $props();

  let targetContext = $state("");
  let targetNamespace = $state("");
  let targetName = $state("");
  /** Free-text namespace for another context (we only know THIS context's list). */
  let foreignNamespace = $state("");
  let loading = $state(false);
  let error = $state("");
  let diffContainer: HTMLDivElement | undefined = $state();
  let mergeView: MergeViewType | null = null;
  let cm: CodeMirrorModules | null = null;
  let hasDiff = $state(false);

  // Candidate namespaces: everything the user can read, minus the source's own.
  const namespaces = $derived(
    k8sStore.namespaces.filter((ns) => ns !== (resource.metadata.namespace ?? "")),
  );
  const contexts = $derived(k8sStore.contexts);
  const sameContext = $derived(!targetContext || targetContext === k8sStore.currentContext);
  const sourceNamespace = $derived(resource.metadata.namespace ?? "");
  /** Cluster-scoped kinds (nodes, namespaces…) only make sense across contexts. */
  const namespaced = $derived(sourceNamespace !== "");
  const effectiveNamespace = $derived(sameContext ? targetNamespace : foreignNamespace);
  const canCompare = $derived(
    !!targetName && (namespaced ? !!effectiveNamespace : true) && (namespaced || !sameContext),
  );

  $effect(() => {
    if (open && resource) {
      targetName = resource.metadata.name;
      targetContext = k8sStore.currentContext;
      foreignNamespace = sourceNamespace;
      if (!targetNamespace || targetNamespace === resource.metadata.namespace) {
        targetNamespace = namespaces[0] ?? "";
      }
      error = "";
      hasDiff = false;
      destroyMergeView();
    }
  });

  function pickContext(ctx: string) {
    targetContext = ctx;
    // Across contexts the natural comparison is the SAME namespace; within
    // this one it has to be a different namespace.
    if (ctx !== k8sStore.currentContext) foreignNamespace = sourceNamespace;
  }

  function destroyMergeView() {
    mergeView?.destroy();
    mergeView = null;
  }

  async function fetchYaml(name: string, namespace: string, context?: string): Promise<string> {
    return invoke<string>("get_resource_yaml", {
      kind: resource.kind,
      name,
      namespace,
      ...(context ? { context } : {}),
    });
  }

  async function compare() {
    if (!canCompare) return;
    loading = true;
    error = "";
    try {
      if (!cm) cm = await loadCodeMirror();
      const [sourceYaml, targetYaml] = await Promise.all([
        fetchYaml(resource.metadata.name, sourceNamespace),
        fetchYaml(targetName, effectiveNamespace, sameContext ? undefined : targetContext),
      ]);
      destroyMergeView();
      hasDiff = true;
      // The container renders with hasDiff — wait a tick for the bind.
      await Promise.resolve();
      if (!diffContainer) return;
      const modules = cm;
      const readOnlyExts = [
        ...getExtensions(modules, "", () => {}, true),
        modules.EditorView.editable.of(false),
      ];
      mergeView = new modules.MergeView({
        a: { doc: sourceYaml, extensions: readOnlyExts },
        b: { doc: targetYaml, extensions: readOnlyExts },
        parent: diffContainer,
        highlightChanges: true,
        gutter: true,
      });
      mergeView.dom.style.height = "100%";
      mergeView.dom.style.minHeight = "0";
      mergeView.dom.style.overflowY = "auto";
    } catch (err) {
      hasDiff = false;
      error = String(err);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (!open) destroyMergeView();
  });
</script>

<Dialog bind:open>
  <DialogContent
    class="flex h-[80vh] max-h-[80vh] flex-col sm:max-w-[1100px]"
    aria-labelledby="compare-dialog-title"
    aria-describedby="compare-dialog-desc"
  >
    <div class="flex min-h-0 flex-1 flex-col gap-3 p-1">
      <div>
        <h3 id="compare-dialog-title" class="text-[13px] font-semibold text-[var(--text-primary)]">
          Compare {resource.kind}
        </h3>
        <p id="compare-dialog-desc" class="mt-1 text-[11px] text-[var(--text-muted)]">
          {#if namespaced}{sourceNamespace}/{/if}{resource.metadata.name} in {k8sStore.currentContext} (left) against a sibling in another namespace or context (right)
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        {#if contexts.length > 1}
          <SelectMenu
            title="Target context"
            value={targetContext}
            items={contexts.map((ctx) => ({ value: ctx, label: ctx, onSelect: () => pickContext(ctx) }))}
            contentClass="min-w-[200px]"
          >
            {#snippet icon()}<Server class="h-3 w-3 text-[var(--text-muted)]" />{/snippet}
          </SelectMenu>
        {/if}
        {#if !namespaced}
          <span class="text-[11px] text-[var(--text-muted)]">cluster-scoped · pick another context</span>
        {:else if sameContext}
          {#if namespaces.length > 0}
            <SelectMenu
              title="Target namespace"
              value={targetNamespace}
              items={namespaces.map((ns) => ({ value: ns, label: ns, onSelect: () => (targetNamespace = ns) }))}
              contentClass="min-w-[180px]"
            >
              {#snippet icon()}<FolderOpen class="h-3 w-3 text-[var(--text-muted)]" />{/snippet}
            </SelectMenu>
          {:else}
            <span class="text-[11px] text-[var(--text-muted)]">No other namespace here — pick another context</span>
          {/if}
        {:else}
          <input
            class="h-7 w-[180px] rounded-sm border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            bind:value={foreignNamespace}
            placeholder="Namespace in {targetContext}"
            aria-label="Target namespace"
          />
        {/if}
        <input
          class="h-7 w-[220px] rounded-sm border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          bind:value={targetName}
          placeholder="Target name"
          aria-label="Target resource name"
        />
        <Button size="sm" mono onclick={compare} disabled={loading || !canCompare}>
          {loading ? "Comparing…" : "Compare"}
        </Button>
      </div>

      {#if error}
        <p class="text-[12px] text-[var(--status-failed)]">{error}</p>
      {/if}

      <div
        class="min-h-0 flex-1 overflow-hidden rounded-sm border border-[var(--border-color)]"
        class:hidden={!hasDiff}
      >
        <div bind:this={diffContainer} class="h-full"></div>
      </div>
      {#if !hasDiff && !error}
        <div class="flex min-h-0 flex-1 items-center justify-center rounded-sm border border-dashed border-[var(--border-color)] text-[12px] text-[var(--text-muted)]">
          Pick a target namespace or context and press Compare
        </div>
      {/if}
    </div>
  </DialogContent>
</Dialog>
