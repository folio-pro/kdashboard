<script lang="ts">
  import { Badge, Button, Input, Textarea } from "$lib/components/ui";
  import { FolderOpen, Import } from "lucide-svelte";
  import { invoke } from "$lib/ipc/core";
  import { toastStore } from "$lib/stores/toast.svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import type { KubeconfigImportResult, KubeconfigPreview } from "$lib/types";

  let importPath = $state("");
  let importContent = $state("");
  let importPreview = $state<KubeconfigPreview | null>(null);
  let importSelected = $state<Set<string>>(new Set());
  let importOverwrite = $state(false);
  let importBusy = $state(false);
  let importError = $state<string | null>(null);

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
      const result = await invoke<KubeconfigPreview>("preview_kubeconfig", importSource);
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
      const result = await invoke<KubeconfigImportResult>(
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

</script>

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
    <Textarea
      class="mt-2 h-20 resize-y"
      mono
      placeholder="…or paste kubeconfig YAML here"
      value={importContent}
      oninput={(e) => { importContent = (e.target as HTMLTextAreaElement).value; importPath = ""; }}
      aria-label="Kubeconfig YAML to import"
    />

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

