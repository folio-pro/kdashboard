<script lang="ts">
  // Helm releases, read straight from the cluster's release Secrets — no helm
  // binary involved. Read-only by design: install/upgrade/rollback are not here.

  import ViewPanel from "$lib/components/common/ViewPanel.svelte";
  import { ScrollArea } from "$lib/components/ui/scroll-area";
  import { Input } from "$lib/components/ui/input";
  import { Package, ArrowLeft } from "lucide-svelte";
  import { helmStore } from "$lib/stores/helm.svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import { filterReleases, releaseHealth } from "$lib/stores/helm.logic";
  import { formatAge } from "$lib/utils/age";
  import { cn } from "$lib/utils";
  import { stringify as toYaml } from "yaml";

  type Tab = "values" | "manifest" | "notes" | "history";

  let query = $state("");
  let tab = $state<Tab>("values");

  let namespaceLabel = $derived(
    k8sStore.currentNamespace === "All Namespaces"
      ? "All Namespaces"
      : k8sStore.currentNamespace || "default",
  );

  let visible = $derived(filterReleases(helmStore.releases, query));

  function handleBack() {
    if (helmStore.selected) {
      helmStore.clearSelection();
      return;
    }
    helmStore.reset();
    uiStore.backToPrevious();
  }

  function handleRefresh() {
    if (helmStore.selected) {
      const { namespace, name } = helmStore.selected;
      void helmStore.selectRelease(namespace, name);
      return;
    }
    void helmStore.loadReleases(k8sStore.currentNamespace);
  }

  function healthColor(status: string): string {
    switch (releaseHealth(status)) {
      case "ok":
        return "var(--status-running)";
      case "pending":
        return "var(--status-pending)";
      case "failed":
        return "var(--status-failed)";
      default:
        return "var(--text-muted)";
    }
  }

  /** Values are YAML everywhere else in the Helm world; render them as YAML. */
  function valuesYaml(values: Record<string, unknown>): string {
    return Object.keys(values).length === 0 ? "{}" : toYaml(values);
  }
</script>

<ViewPanel
  title="Helm Releases"
  icon={Package}
  namespace={namespaceLabel}
  isLoading={helmStore.isLoading}
  error={helmStore.error}
  hasData={helmStore.loaded}
  onBack={handleBack}
  onRefresh={handleRefresh}
  loadingMessage="Reading release secrets..."
  errorMessage="Failed to read Helm releases"
  emptyMessage="No Helm releases found"
  emptyHelper="Releases are read from Secrets labelled owner=helm in the selected namespace"
>
  {#snippet headerActions()}
    {#if !helmStore.selected}
      <Input
        type="text"
        placeholder="Filter releases..."
        value={query}
        oninput={(e) => { query = (e.target as HTMLInputElement).value; }}
        class="h-8 w-56 text-xs"
      />
    {/if}
  {/snippet}

  {#if helmStore.selected}
    {@const release = helmStore.selected}
    <div class="flex h-full flex-col">
      <div class="flex items-center gap-3 border-b border-[var(--border-color)] px-4 py-3">
        <button
          class="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
          onclick={() => helmStore.clearSelection()}
        >
          <ArrowLeft class="h-3.5 w-3.5" />
          All releases
        </button>
        <span class="text-sm font-semibold text-[var(--text-primary)]">{release.name}</span>
        <span class="font-mono text-[11px] text-[var(--text-muted)]">
          {release.chart}-{release.chart_version} · rev {release.revision}
        </span>
        <span class="font-mono text-[11px]" style="color: {healthColor(release.status)}">{release.status}</span>
      </div>

      <div class="flex gap-1 border-b border-[var(--border-color)] px-4">
        {#each ["values", "manifest", "notes", "history"] as const as t}
          <button
            class={cn(
              "border-b-2 px-3 py-2 text-[11.5px] transition-colors",
              tab === t
                ? "border-[var(--accent)] text-[var(--text-primary)]"
                : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
            )}
            onclick={() => (tab = t)}
          >
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        {/each}
      </div>

      <ScrollArea class="min-h-0 flex-1">
        {#if tab === "values"}
          <div class="grid grid-cols-2 gap-4 p-4">
            <div>
              <h3 class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">User-supplied values</h3>
              <pre class="overflow-x-auto rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 font-mono text-[11px] text-[var(--text-secondary)]">{valuesYaml(release.values)}</pre>
            </div>
            <div>
              <h3 class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Chart defaults</h3>
              <pre class="overflow-x-auto rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 font-mono text-[11px] text-[var(--text-dimmed)]">{valuesYaml(release.chart_values)}</pre>
            </div>
          </div>
        {:else if tab === "manifest"}
          <pre class="m-4 overflow-x-auto rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 font-mono text-[11px] text-[var(--text-secondary)]">{release.manifest || "(empty manifest)"}</pre>
        {:else if tab === "notes"}
          <pre class="m-4 whitespace-pre-wrap rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 font-mono text-[11px] text-[var(--text-secondary)]">{release.notes || "(this chart rendered no NOTES.txt)"}</pre>
        {:else}
          <table class="w-full text-left text-[11.5px]">
            <thead class="border-b border-[var(--border-color)] text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
              <tr>
                <th class="px-4 py-2 font-medium">Revision</th>
                <th class="px-4 py-2 font-medium">Status</th>
                <th class="px-4 py-2 font-medium">Chart</th>
                <th class="px-4 py-2 font-medium">App</th>
                <th class="px-4 py-2 font-medium">Updated</th>
                <th class="px-4 py-2 font-medium">Description</th>
              </tr>
            </thead>
            <tbody>
              {#each helmStore.history as rev}
                <tr
                  class={cn(
                    "border-b border-[var(--border-color)] hover:bg-[var(--table-row-hover)]",
                    rev.revision === release.revision && "bg-[var(--accent)]/10",
                  )}
                >
                  <!-- The button, not the row, carries the interaction: a click
                       handler on <tr> is unreachable by keyboard. -->
                  <td class="px-4 py-2">
                    <button
                      class="w-full text-left font-mono tabular-nums text-[var(--text-primary)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
                      onclick={() => helmStore.selectRelease(rev.namespace, rev.name, rev.revision)}
                      aria-label={`Show revision ${rev.revision}`}
                    >{rev.revision}</button>
                  </td>
                  <td class="px-4 py-2 font-mono" style="color: {healthColor(rev.status)}">{rev.status}</td>
                  <td class="px-4 py-2 font-mono text-[var(--text-secondary)]">{rev.chart_version}</td>
                  <td class="px-4 py-2 font-mono text-[var(--text-secondary)]">{rev.app_version}</td>
                  <td class="px-4 py-2 font-mono text-[var(--text-muted)]">{formatAge(rev.updated)}</td>
                  <td class="px-4 py-2 text-[var(--text-muted)]">{rev.description}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </ScrollArea>
    </div>
  {:else}
    <ScrollArea class="h-full">
      <table class="w-full text-left text-[11.5px]">
        <thead class="border-b border-[var(--border-color)] text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
          <tr>
            <th class="px-4 py-2 font-medium">Name</th>
            <th class="px-4 py-2 font-medium">Namespace</th>
            <th class="px-4 py-2 font-medium">Chart</th>
            <th class="px-4 py-2 font-medium">App Version</th>
            <th class="px-4 py-2 font-medium">Rev</th>
            <th class="px-4 py-2 font-medium">Status</th>
            <th class="px-4 py-2 font-medium">Updated</th>
          </tr>
        </thead>
        <tbody>
          {#each visible as release}
            <tr class="border-b border-[var(--border-color)] hover:bg-[var(--table-row-hover)]">
              <td class="px-4 py-2">
                <button
                  class="w-full text-left font-medium text-[var(--text-primary)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
                  onclick={() => helmStore.selectRelease(release.namespace, release.name)}
                  aria-label={`Open Helm release ${release.name}`}
                >{release.name}</button>
              </td>
              <td class="px-4 py-2 text-[var(--text-muted)]">{release.namespace}</td>
              <td class="px-4 py-2 font-mono text-[var(--text-secondary)]">{release.chart}-{release.chart_version}</td>
              <td class="px-4 py-2 font-mono text-[var(--text-secondary)]">{release.app_version || "—"}</td>
              <td class="px-4 py-2 font-mono tabular-nums text-[var(--text-secondary)]">{release.revision}</td>
              <td class="px-4 py-2 font-mono" style="color: {healthColor(release.status)}">{release.status}</td>
              <td class="px-4 py-2 font-mono text-[var(--text-muted)]">{formatAge(release.updated)}</td>
            </tr>
          {/each}
        </tbody>
      </table>

      {#if visible.length === 0 && helmStore.releases.length > 0}
        <p class="p-4 text-[11.5px] text-[var(--text-muted)]">No release matches "{query}".</p>
      {/if}
    </ScrollArea>
  {/if}
</ViewPanel>
