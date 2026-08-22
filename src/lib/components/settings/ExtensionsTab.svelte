<script lang="ts">
  import { Badge, Button } from "$lib/components/ui";
  import { FolderOpen, RefreshCw, BookOpen } from "lucide-svelte";
  import { invoke } from "$lib/ipc/core";
  import { open as shellOpen } from "$lib/ipc/shell";
  import { toastStore } from "$lib/stores/toast.svelte";
  import { extensionStatuses, extensionsDirectory } from "$lib/extensions/host";
  import { API_VERSION } from "$lib/extensions/api";

  const DOCS_URL = "https://github.com/folio-pro/kdashboard/blob/main/docs/extensions.md";

  async function openDir() {
    try {
      await invoke("open_extensions_dir", {});
    } catch (err) {
      toastStore.error("Could not open the extensions folder", String(err));
    }
  }
  function reload() {
    location.reload();
  }
</script>

<section data-testid="extensions-tab">
  <h2 class="text-[12px] font-semibold uppercase tracking-wider text-[var(--text-primary)]">Extensions</h2>
  <p class="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">
    Drop a folder with a <span class="font-mono">manifest.json</span> and an ES module into the extensions directory; it is loaded at start-up and may register actions, palette commands, settings tabs, UI slots and event handlers through the extension API (v{API_VERSION}).
    {#if extensionsDirectory}<span class="font-mono text-[var(--text-secondary)]">{extensionsDirectory}</span>{/if}
  </p>
  <div class="mt-3 flex gap-2">
    <Button size="md" variant="outline" onclick={openDir}><FolderOpen class="h-3.5 w-3.5" /> Open folder</Button>
    <Button size="md" variant="outline" onclick={reload} title="Extensions load once at start-up"><RefreshCw class="h-3.5 w-3.5" /> Reload app</Button>
    <Button size="md" variant="ghost" onclick={() => shellOpen(DOCS_URL)}><BookOpen class="h-3.5 w-3.5" /> API docs</Button>
  </div>

  <div class="mt-4 space-y-1.5">
    {#if extensionStatuses.length === 0}
      <div class="rounded-lg border border-dashed border-[var(--border-color)] px-4 py-3 text-center text-[11px] text-[var(--text-muted)]">No extensions installed.</div>
    {/if}
    {#each extensionStatuses as ext (ext.id)}
      <div class="rounded-lg border border-[var(--border-color)] px-3 py-2.5" data-testid="extension-row">
        <div class="flex items-center gap-2">
          <span class="text-[12px] font-medium text-[var(--text-primary)]">{ext.name}</span>
          <span class="font-mono text-[11px] text-[var(--text-muted)]">{ext.id} · v{ext.version}</span>
          <div class="flex-1"></div>
          <Badge tone={ext.state === "active" ? "success" : ext.state === "failed" ? "error" : "warning"}>{ext.state}</Badge>
        </div>
        {#if ext.description}<p class="mt-1 text-[11px] text-[var(--text-secondary)]">{ext.description}</p>{/if}
        {#if ext.error}<p class="mt-1 font-mono text-[11px] text-[var(--status-failed)]">{ext.error}</p>{/if}
        {#if ext.registered.length}<p class="mt-1 text-[11px] text-[var(--text-muted)]">registered: {ext.registered.join(", ")}</p>{/if}
        <p class="mt-1 font-mono text-[10px] text-[var(--text-muted)]">{ext.dir}</p>
      </div>
    {/each}
  </div>
</section>
