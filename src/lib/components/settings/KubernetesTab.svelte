<script lang="ts">
  import { Badge } from "$lib/components/ui";
  import { cn } from "$lib/utils";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { X, RefreshCw, FolderOpen, Trash2, Import } from "lucide-svelte";
  import ConfirmDialog from "$lib/components/common/ConfirmDialog.svelte";
  import { settingsStore } from "$lib/stores/settings.svelte";
  import { toastStore } from "$lib/stores/toast.svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { costStore } from "$lib/stores/cost.svelte";
  import { metricsStore } from "$lib/stores/metrics.svelte";
  import { getIconById, iconsByCategory } from "$lib/utils/context-icons";
  import { getContextColor } from "$lib/utils/context-colors";
  import DeviconIcon from "$lib/components/common/DeviconIcon.svelte";
  import { invoke } from "$lib/ipc/core";
  import { COLOR_OPTIONS, ICON_CATEGORIES } from "./settings-constants";

  let kubeconfigPath = $state(settingsStore.settings.kubeconfig_path);
  let prometheusUrl = $state(settingsStore.settings.prometheus_url ?? "");
  let testingPrometheus = $state(false);
  let editingContext = $state<string | null>(null);
  let refreshingPricing = $state(false);
  let labelDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  // --- Kubeconfig import -----------------------------------------------------
  interface PreviewRow { name: string; cluster: string; user: string; server?: string; namespace?: string; status: "new" | "identical" | "conflict" }
  interface MergeSection { added: string[]; replaced: string[]; skipped: string[] }
  let importPath = $state("");
  let importContent = $state("");
  let importPreview = $state<{ file: string; source: string; rows: PreviewRow[] } | null>(null);
  let importSelected = $state<Set<string>>(new Set());
  let importOverwrite = $state(false);
  let importBusy = $state(false);
  let importError = $state<string | null>(null);
  let removingContext = $state<string | null>(null);

  const importSource = $derived(importContent.trim() ? { content: importContent } : { path: importPath.trim() });
  const canPreview = $derived(!!importContent.trim() || !!importPath.trim());

  async function pickKubeconfigFile() {
    try {
      const picked = await invoke<string | null>("pick_kubeconfig_file");
      if (picked) {
        importPath = picked;
        importContent = "";
        await previewImport();
      }
    } catch (e) {
      importError = String(e);
    }
  }

  async function previewImport() {
    importBusy = true;
    importError = null;
    try {
      const result = await invoke<{ file: string; source: string; rows: PreviewRow[] }>("preview_kubeconfig", importSource);
      importPreview = result;
      // Preselect everything that would change; identical entries are noise.
      importSelected = new Set(result.rows.filter((r) => r.status !== "identical").map((r) => r.name));
    } catch (e) {
      importPreview = null;
      importError = String(e);
    } finally {
      importBusy = false;
    }
  }

  function toggleImportRow(name: string) {
    const next = new Set(importSelected);
    if (next.has(name)) next.delete(name); else next.add(name);
    importSelected = next;
  }

  async function runImport() {
    if (!importPreview || importSelected.size === 0) return;
    importBusy = true;
    importError = null;
    try {
      const result = await invoke<{ file: string; backup: string | null; contexts: MergeSection; clusters: MergeSection; users: MergeSection }>(
        "import_kubeconfig",
        { ...importSource, overwrite: importOverwrite, contexts: [...importSelected] },
      );
      const added = result.contexts.added.length;
      const replaced = result.contexts.replaced.length;
      toastStore.success(
        "Kubeconfig updated",
        `${added} context${added === 1 ? "" : "s"} added${replaced ? `, ${replaced} replaced` : ""}${result.backup ? ` · backup at ${result.backup}` : ""}`,
      );
      importPreview = null;
      importPath = "";
      importContent = "";
      await k8sStore.loadContexts();
    } catch (e) {
      importError = String(e);
    } finally {
      importBusy = false;
    }
  }

  async function confirmRemoveContext() {
    const ctx = removingContext;
    if (!ctx) return;
    try {
      await invoke("remove_kubeconfig_context", { context: ctx });
      toastStore.success("Context removed", `${ctx} was removed from the kubeconfig (a backup was written next to it)`);
      await k8sStore.loadContexts();
    } catch (e) {
      toastStore.error("Could not remove context", String(e));
    } finally {
      removingContext = null;
    }
  }

  function handleKubeconfigSave() {
    settingsStore.updateKubeconfigPath(kubeconfigPath);
    toastStore.success("Kubeconfig path saved");
  }

  function handlePrometheusSave() {
    settingsStore.updatePrometheusUrl(prometheusUrl.trim());
    toastStore.success(
      prometheusUrl.trim() ? "Prometheus URL saved" : "Prometheus disabled",
    );
  }

  /** Save first, then run a trivial query so the test hits what was stored. */
  async function handlePrometheusTest() {
    testingPrometheus = true;
    try {
      settingsStore.updatePrometheusUrl(prometheusUrl.trim());
      const result = await metricsStore.queryRange("up", 5);
      if (!result.configured) {
        toastStore.error("No Prometheus URL set");
      } else {
        toastStore.success("Prometheus reachable", `${result.series.length} series returned for "up"`);
      }
    } catch (e) {
      toastStore.error("Prometheus test failed", String(e));
    } finally {
      testingPrometheus = false;
    }
  }

  function setContextIcon(context: string, iconId: string | undefined) {
    const current = settingsStore.getContextCustomization(context) ?? {};
    settingsStore.updateContextCustomization(context, { ...current, icon: iconId });
  }

  function setContextLabel(context: string, label: string) {
    clearTimeout(labelDebounceTimer);
    const trimmed = label.slice(0, 3);
    labelDebounceTimer = setTimeout(() => {
      const current = settingsStore.getContextCustomization(context) ?? {};
      settingsStore.updateContextCustomization(context, { ...current, label: trimmed || undefined });
    }, 300);
  }

  function setContextColor(context: string, color: string | undefined) {
    const current = settingsStore.getContextCustomization(context) ?? {};
    settingsStore.updateContextCustomization(context, { ...current, color });
  }

  function resetContext(context: string) {
    settingsStore.updateContextCustomization(context, {});
  }
</script>

<!-- Context Customization -->
<section>
  <h2 class="text-[12px] font-semibold uppercase tracking-wider text-[var(--text-primary)]">Contexts</h2>
  <p class="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
    Assign icons, labels, and colors to your contexts to tell them apart in the sidebar.
  </p>

  <div class="mt-4 space-y-1.5">
    {#each k8sStore.contexts as ctx}
      {@const custom = settingsStore.getContextCustomization(ctx)}
      {@const isEditing = editingContext === ctx}
      {@const isActive = ctx === k8sStore.currentContext}
      {@const hasCustom = custom?.icon || custom?.label || custom?.color}
      {@const iconDef = custom?.icon ? getIconById(custom.icon) : undefined}
      {@const badgeColor = custom?.color || getContextColor(ctx)}
      <div class={cn("rounded-lg border transition-colors", isEditing ? "border-[var(--accent)]/40" : "border-[var(--border-color)]")}>
        <!-- Context row -->
        <button
          class={cn(
            "flex w-full items-center gap-3 px-3 py-2.5 text-left text-[12px] transition-colors",
            isEditing ? "rounded-t-lg bg-[var(--bg-secondary)]" : "rounded-lg hover:bg-[var(--bg-secondary)]/50"
          )}
          onclick={() => { editingContext = isEditing ? null : ctx; }}
        >
          <!-- Live sidebar preview badge -->
          <span
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
            style="background-color: color-mix(in srgb, var({badgeColor}) 20%, transparent); color: var({badgeColor});"
          >
            {#if iconDef && custom?.label}
              <span class="flex flex-col items-center gap-0.5">
                <DeviconIcon id={iconDef.id} class="h-4 w-4" />
                <span class="text-[10px] font-bold leading-none tracking-tight">{custom.label}</span>
              </span>
            {:else if iconDef}
              <DeviconIcon id={iconDef.id} class="h-5.5 w-5.5" />
            {:else if custom?.label}
              <span class="text-[10px] font-bold leading-none tracking-tight">{custom.label}</span>
            {:else}
              <span class="text-[13px] font-bold">{ctx.charAt(0).toUpperCase()}</span>
            {/if}
          </span>
          <span class="flex-1 truncate font-medium text-[var(--text-primary)]">{ctx}</span>
          {#if isActive}
            <Badge tone="accent" pill class="px-2">active</Badge>
          {/if}
          {#if hasCustom}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <span
              role="button"
              tabindex="0"
              class="flex h-5 w-5 items-center justify-center rounded-sm text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
              onclick={(e) => { e.stopPropagation(); resetContext(ctx); }}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); resetContext(ctx); } }}
              title="Reset customization"
            >
              <X class="h-3 w-3" />
            </span>
          {/if}
        </button>

        <!-- Expanded editor -->
        {#if isEditing}
          <div class="border-t border-[var(--border-color)] px-3 py-3 space-y-4">
            <!-- Custom label -->
            <div>
              <span class="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Label (max 3 chars)</span>
              <Input
                type="text"
                placeholder="e.g. PRD, STG, DEV"
                value={custom?.label ?? ""}
                oninput={(e) => setContextLabel(ctx, (e.target as HTMLInputElement).value)}
                maxlength={3}
                class="h-8 w-40 font-mono text-[12px] uppercase"
              />
            </div>

            <!-- Icon picker -->
            <div>
              <span class="mb-2 block text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Icon</span>
              {#each ICON_CATEGORIES as cat}
                {@const icons = iconsByCategory[cat.key] ?? []}
                <div class="mb-2.5">
                  <span class="mb-1 block text-[10px] text-[var(--text-muted)]">{cat.label}</span>
                  <div class="flex flex-wrap gap-1">
                    {#each icons as icon}
                      {@const isSelected = custom?.icon === icon.id}
                      <button
                        class={cn(
                          "group relative flex h-8 w-8 items-center justify-center rounded-md border transition-all",
                          isSelected
                            ? "border-[var(--accent)] bg-[var(--accent)]/10"
                            : "border-transparent hover:border-[var(--border-color)] hover:bg-[var(--bg-tertiary)]"
                        )}
                        onclick={() => setContextIcon(ctx, isSelected ? undefined : icon.id)}
                        title={icon.label}
                      >
                        <DeviconIcon id={icon.id} class="h-4.5 w-4.5" />
                      </button>
                    {/each}
                  </div>
                </div>
              {/each}
            </div>

            <!-- Color picker -->
            <div>
              <span class="mb-1.5 block text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">Color</span>
              <div class="flex gap-1.5">
                {#each COLOR_OPTIONS as colorOpt}
                  {@const isSelected = custom?.color === colorOpt.id}
                  <button
                    class={cn(
                      "flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[10px] transition-all",
                      isSelected
                        ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text-primary)]"
                        : "border-[var(--border-color)] text-[var(--text-secondary)] hover:border-[var(--border-hover)]"
                    )}
                    onclick={() => setContextColor(ctx, isSelected ? undefined : colorOpt.id)}
                  >
                    <span
                      class="h-2.5 w-2.5 rounded-full"
                      style="background-color: var({colorOpt.id});"
                    ></span>
                    {colorOpt.label}
                  </button>
                {/each}
              </div>
            </div>
            <div class="flex items-center justify-between gap-2 border-t border-[var(--border-color)] pt-3">
              <span class="text-[11px] text-[var(--text-muted)]">
                {isActive ? "Switch to another context before removing this one." : "Removes the context (and its cluster/user if unused) from the kubeconfig file."}
              </span>
              <Button
                variant="ghost-tone"
                tone="error"
                size="sm"
                disabled={isActive}
                onclick={() => (removingContext = ctx)}
                data-testid="remove-context"
              >
                <Trash2 class="h-3 w-3" /> Remove from kubeconfig
              </Button>
            </div>
          </div>
        {/if}
      </div>
    {/each}
  </div>

  {#if k8sStore.contexts.length === 0}
    <div class="mt-3 rounded-lg border border-dashed border-[var(--border-color)] px-4 py-3 text-center">
      <p class="text-[11px] text-[var(--text-muted)]">
        No contexts found. Check your kubeconfig path below.
      </p>
    </div>
  {/if}
</section>

<!-- Kubernetes Configuration -->
<section>
  <h2 class="text-[12px] font-semibold uppercase tracking-wider text-[var(--text-primary)]">Kubeconfig</h2>
  <p class="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
    Path to your kubeconfig file. Leave empty to use the default location (~/.kube/config).
  </p>
  <div class="mt-4 flex gap-2">
    <Input
      type="text"
      placeholder="~/.kube/config"
      value={kubeconfigPath}
      oninput={(e) => { kubeconfigPath = (e.target as HTMLInputElement).value; }}
      size="lg"
      class="flex-1"
    />
    <Button
      size="lg"
      onclick={handleKubeconfigSave}
    >
      Save
    </Button>
  </div>

  <!-- Import / merge -->
  <div class="mt-6 rounded-lg border border-[var(--border-color)] p-4" data-testid="kubeconfig-import">
    <div class="flex items-center gap-2">
      <Import class="h-3.5 w-3.5 text-[var(--text-muted)]" />
      <h3 class="text-[12px] font-semibold text-[var(--text-primary)]">Import another kubeconfig</h3>
    </div>
    <p class="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
      Merge the contexts of another kubeconfig (a file your cloud CLI wrote, or YAML you were sent) into the active one.
      Existing entries are kept unless you choose to overwrite; the file is backed up before writing.
    </p>
    <div class="mt-3 flex gap-2">
      <Input
        type="text"
        placeholder="/path/to/other/kubeconfig"
        value={importPath}
        oninput={(e) => { importPath = (e.target as HTMLInputElement).value; importContent = ""; }}
        size="md"
        class="flex-1 font-mono"
        aria-label="Kubeconfig file to import"
      />
      <Button size="md" variant="outline" onclick={pickKubeconfigFile} title="Choose a file">
        <FolderOpen class="h-3.5 w-3.5" /> Browse…
      </Button>
      <Button size="md" onclick={previewImport} disabled={!canPreview || importBusy} data-testid="kubeconfig-preview">
        {importBusy ? "Reading…" : "Preview"}
      </Button>
    </div>
    <textarea
      class="mt-2 h-20 w-full resize-y rounded-sm border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1.5 font-mono text-[11px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
      placeholder="…or paste kubeconfig YAML here"
      bind:value={importContent}
      oninput={() => { importPath = ""; }}
      aria-label="Kubeconfig YAML to import"
    ></textarea>

    {#if importError}
      <p class="mt-2 text-[11px] text-[var(--status-failed)]" data-testid="kubeconfig-import-error">{importError}</p>
    {/if}

    {#if importPreview}
      <div class="mt-3 overflow-hidden rounded-md border border-[var(--border-color)]" data-testid="kubeconfig-preview-rows">
        <div class="flex items-center gap-2 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-1.5 text-[11px] text-[var(--text-muted)]">
          <span class="font-mono">{importPreview.source}</span>
          <span>→</span>
          <span class="font-mono">{importPreview.file}</span>
          <span class="ml-auto">{importPreview.rows.length} context{importPreview.rows.length === 1 ? "" : "s"}</span>
        </div>
        {#each importPreview.rows as row (row.name)}
          <label class="flex cursor-pointer items-center gap-3 border-b border-[var(--border-color)] px-3 py-2 text-[12px] last:border-b-0 hover:bg-[var(--bg-secondary)]/50">
            <input type="checkbox" checked={importSelected.has(row.name)} onchange={() => toggleImportRow(row.name)} disabled={row.status === "identical"} />
            <span class="min-w-0 flex-1">
              <span class="font-mono text-[var(--text-primary)]">{row.name}</span>
              <span class="ml-2 text-[11px] text-[var(--text-muted)]">{row.server ?? row.cluster}{row.namespace ? ` · ns ${row.namespace}` : ""}</span>
            </span>
            <Badge tone={row.status === "new" ? "success" : row.status === "conflict" ? "warning" : "muted"}>{row.status}</Badge>
          </label>
        {/each}
        <div class="flex items-center gap-3 bg-[var(--bg-secondary)] px-3 py-2">
          {#if importPreview.rows.some((r) => r.status === "conflict")}
            <label class="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
              <input type="checkbox" bind:checked={importOverwrite} /> Overwrite conflicting entries
            </label>
          {/if}
          <div class="flex-1"></div>
          <Button size="sm" variant="outline" onclick={() => (importPreview = null)}>Cancel</Button>
          <Button size="sm" onclick={runImport} disabled={importBusy || importSelected.size === 0} data-testid="kubeconfig-import-run">
            Import {importSelected.size} context{importSelected.size === 1 ? "" : "s"}
          </Button>
        </div>
      </div>
    {/if}
  </div>
</section>

<ConfirmDialog
  open={removingContext !== null}
  title="Remove context from kubeconfig"
  description={removingContext ? `Remove "${removingContext}" from ${settingsStore.settings.kubeconfig_path || "~/.kube/config"}? Its cluster and user entries go too if nothing else uses them. A backup of the file is written first.` : ""}
  confirmLabel="Remove"
  variant="destructive"
  onconfirm={confirmRemoveContext}
  oncancel={() => (removingContext = null)}
/>

<!-- Prometheus -->
<section>
  <h2 class="text-[12px] font-semibold uppercase tracking-wider text-[var(--text-primary)]">Prometheus</h2>
  <p class="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
    Optional. metrics-server only reports the latest scrape, so charts over time need a Prometheus.
    Point this at one reachable from this machine — an ingress URL, or
    <span class="font-mono">http://localhost:9090</span> while you port-forward it.
  </p>
  <div class="mt-4 flex gap-2">
    <Input
      type="text"
      placeholder="http://localhost:9090"
      value={prometheusUrl}
      oninput={(e) => { prometheusUrl = (e.target as HTMLInputElement).value; }}
      size="lg"
      class="flex-1"
    />
    <Button size="lg" variant="outline" onclick={handlePrometheusTest} disabled={testingPrometheus}>
      {testingPrometheus ? "Testing..." : "Test"}
    </Button>
    <Button size="lg" onclick={handlePrometheusSave}>Save</Button>
  </div>
</section>

<!-- Cost Pricing -->
<section>
  <h2 class="text-[12px] font-semibold uppercase tracking-wider text-[var(--text-primary)]">Cost Pricing</h2>
  <p class="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
    Node pricing is fetched from cloud providers (AWS, Azure, GCP) and cached for 24 hours.
    Prices are updated monthly on the server. Force a refresh if you need the latest rates.
  </p>
  <div class="mt-4 flex items-center gap-3">
    <Button
      size="lg"
      variant="outline"
      onclick={async () => {
        refreshingPricing = true;
        try {
          await invoke("refresh_pricing");
          costStore.reset();
          toastStore.success("Pricing cache cleared. Prices will refresh on next load.");
        } catch (e) {
          toastStore.error("Failed to refresh pricing: " + e);
        } finally {
          refreshingPricing = false;
        }
      }}
      disabled={refreshingPricing}
    >
      <RefreshCw class="h-3.5 w-3.5 {refreshingPricing ? 'animate-spin' : ''}" />
      Refresh Pricing
    </Button>
    <span class="text-[11px] text-[var(--text-muted)]">
      Clears local cache and re-fetches from server on next cost/node view.
    </span>
  </div>
</section>
