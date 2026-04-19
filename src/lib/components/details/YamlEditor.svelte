<script lang="ts">
  import { onDestroy } from "svelte";
  import { cn } from "$lib/utils";
  import {
    Copy,
    Check,
    Loader2,
    Save,
    Undo2,
    Redo2,
    RotateCcw,
    History,
    Code,
    Search,
  } from "lucide-svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { uiStore } from "$lib/stores/ui.svelte";
  import type { Resource } from "$lib/types";
  import { CodeSkeleton } from "$lib/components/ui/skeleton";
  import YamlHistoryPanel from "./YamlHistoryPanel.svelte";

  // CodeMirror is lazy-loaded (~426KB) — only fetched when the editor is first needed
  import { loadCodeMirror, type CodeMirrorModules } from "$lib/utils/codemirror-lazy";
  import type { EditorView as EditorViewType } from "@codemirror/view";
  import type { MergeView as MergeViewType } from "@codemirror/merge";

  import { initDiffMarkers, dirtyDiffCompartment, dirtyDiff } from "./diff-tracking";
  import { getExtensions } from "./codemirror-extensions";

  // Lazy-loaded modules — null until loadCodeMirror() resolves
  let cm = $state<CodeMirrorModules | null>(null);
  let cmLoadError = $state<string | null>(null);

  let resource = $derived(k8sStore.selectedResource);

  // State
  let originalYaml = $state<string>("");
  let isLoading = $state<boolean>(true);
  let error = $state<string | null>(null);
  let copied = $state<boolean>(false);
  let isSaving = $state<boolean>(false);
  let saveError = $state<string | null>(null);
  let saveSuccess = $state<boolean>(false);

  // Tabs: editor, history
  type Tab = "editor" | "history";
  let activeTab = $state<Tab>("editor");

  // History entries
  interface HistoryEntry {
    yaml: string;
    timestamp: Date;
    label: string;
  }
  let yamlHistory = $state<HistoryEntry[]>([]);
  let selectedHistoryIndex = $state<number | null>(null);

  // CodeMirror
  let editorContainer = $state<HTMLDivElement | null>(null);
  let historyDiffContainer = $state<HTMLDivElement | null>(null);
  let editorView: EditorViewType | null = null;
  let historyMergeView: MergeViewType | null = null;

  // Track current content for diff
  let currentContent = $state<string>("");
  let isModified = $derived(currentContent !== originalYaml);

  function initEditor(modules: CodeMirrorModules) {
    if (!editorContainer || editorView) return;

    editorView = new modules.EditorView({
      state: modules.EditorState.create({
        doc: originalYaml,
        extensions: getExtensions(modules, originalYaml, (c) => { currentContent = c; }, false),
      }),
      parent: editorContainer,
    });
    currentContent = originalYaml;
  }

  function createMergeView(modules: CodeMirrorModules, docA: string, docB: string, parent: HTMLElement): MergeViewType {
    const readOnlyExts = [...getExtensions(modules, originalYaml, () => {}, true), modules.EditorView.editable.of(false)];
    const mv = new modules.MergeView({
      a: { doc: docA, extensions: readOnlyExts },
      b: { doc: docB, extensions: readOnlyExts },
      parent,
      highlightChanges: true,
      gutter: true,
    });
    mv.dom.style.height = "100%";
    mv.dom.style.minHeight = "0";
    mv.dom.style.overflowY = "auto";
    return mv;
  }

  function initHistoryDiffView(modules: CodeMirrorModules, historyYaml: string, compareYaml: string) {
    if (!historyDiffContainer) return;
    destroyHistoryMergeView();
    historyMergeView = createMergeView(modules, historyYaml, compareYaml, historyDiffContainer);
  }

  function destroyEditor() {
    editorView?.destroy();
    editorView = null;
  }

  function destroyHistoryMergeView() {
    historyMergeView?.destroy();
    historyMergeView = null;
  }

  // Load CodeMirror lazily when resource is present
  $effect(() => {
    if (resource && !cm && !cmLoadError) {
      loadCodeMirror()
        .then((modules) => {
          cm = modules;
          initDiffMarkers(modules);
        })
        .catch((err) => {
          cmLoadError = `Failed to load editor: ${err}`;
        });
    }
  });

  $effect(() => {
    if (resource) {
      loadYaml(resource);
    }
  });

  // Initialize editor when tab changes and CodeMirror is loaded
  $effect(() => {
    if (activeTab === "editor" && !isLoading && !error && cm) {
      const modules = cm;
      requestAnimationFrame(() => {
        if (!editorView && editorContainer) {
          initEditor(modules);
        }
      });
    }
  });

  // Initialize history diff when selection changes
  $effect(() => {
    if (activeTab === "history" && selectedHistoryIndex !== null && yamlHistory.length > 0 && cm) {
      const modules = cm;
      const entry = yamlHistory[selectedHistoryIndex];
      const compareWith = selectedHistoryIndex < yamlHistory.length - 1
        ? yamlHistory[selectedHistoryIndex + 1].yaml
        : originalYaml;
      requestAnimationFrame(() => {
        initHistoryDiffView(modules, compareWith, entry.yaml);
      });
    }
  });

  async function loadYaml(r: Resource) {
    isLoading = true;
    error = null;
    saveError = null;
    saveSuccess = false;
    destroyEditor();
    destroyHistoryMergeView();
    activeTab = "editor";
    yamlHistory = [];
    selectedHistoryIndex = null;

    try {
      const result = await invoke<string>("get_resource_yaml", {
        kind: r.kind,
        name: r.metadata.name,
        namespace: r.metadata.namespace ?? "",
      });
      originalYaml = result;
      currentContent = result;

      yamlHistory = [{
        yaml: result,
        timestamp: new Date(),
        label: "Loaded from cluster",
      }];
    } catch (err) {
      error = `Failed to load YAML: ${err}`;
      originalYaml = "";
      currentContent = "";
    } finally {
      isLoading = false;
    }
  }

  async function saveYaml() {
    isSaving = true;
    saveError = null;
    saveSuccess = false;

    try {
      const updatedYaml = await invoke<string>("apply_yaml", { yaml: currentContent });

      yamlHistory = [
        {
          yaml: updatedYaml,
          timestamp: new Date(),
          label: "Applied to cluster",
        },
        ...yamlHistory,
      ].slice(0, 20);

      originalYaml = updatedYaml;
      currentContent = updatedYaml;

      if (editorView && cm && dirtyDiffCompartment) {
        editorView.dispatch({
          changes: {
            from: 0,
            to: editorView.state.doc.length,
            insert: updatedYaml,
          },
          effects: dirtyDiffCompartment.reconfigure(dirtyDiff(cm, updatedYaml)),
        });
      }

      saveSuccess = true;
      setTimeout(() => { saveSuccess = false; }, 3000);
    } catch (err) {
      saveError = `Failed to apply: ${err}`;
    } finally {
      isSaving = false;
    }
  }

  function resetToOriginal() {
    if (!editorView) return;
    editorView.dispatch({
      changes: {
        from: 0,
        to: editorView.state.doc.length,
        insert: originalYaml,
      },
    });
    currentContent = originalYaml;
  }

  function handleUndo() {
    if (editorView && cm) cm.undo(editorView);
  }

  function handleRedo() {
    if (editorView && cm) cm.redo(editorView);
  }

  function handleSearch() {
    if (editorView && cm) cm.openSearchPanel(editorView);
  }

  async function copyToClipboard() {
    try {
      await navigator.clipboard.writeText(currentContent);
      copied = true;
      setTimeout(() => { copied = false; }, 2000);
    } catch {}
  }

  function restoreFromHistory(index: number) {
    const entry = yamlHistory[index];
    if (!editorView) return;

    editorView.dispatch({
      changes: {
        from: 0,
        to: editorView.state.doc.length,
        insert: entry.yaml,
      },
    });
    currentContent = entry.yaml;
    activeTab = "editor";
  }

  function close() {
    if (uiStore.activeTab?.closable) {
      uiStore.closeTab(uiStore.activeTabId);
    }
  }

  onDestroy(() => {
    destroyEditor();
    destroyHistoryMergeView();
  });
</script>

{#if resource}
  <div class="flex h-full flex-col bg-[var(--bg-primary)]">
    <!-- Header -->
    <div class="flex h-[68px] shrink-0 items-center justify-between border-b border-[var(--border-color)] px-6">
      <!-- Left: Resource Info -->
      <div class="flex flex-col gap-0.5">
        <div class="flex items-center gap-2">
          <span class="font-mono text-base font-semibold text-[var(--text-primary)]">Edit YAML</span>
          {#if isModified}
            <span class="rounded bg-[var(--status-warning)]/15 px-1.5 py-0.5 text-[9px] font-semibold text-[var(--status-warning)]">MODIFIED</span>
          {/if}
          {#if saveSuccess}
            <span class="rounded bg-[var(--status-running)]/15 px-1.5 py-0.5 text-[9px] font-semibold text-[var(--status-running)]">SAVED</span>
          {/if}
        </div>
        <span class="font-mono text-[11px] text-[var(--text-muted)]">{resource.kind}/{resource.metadata.name}{resource.metadata.namespace ? ` (${resource.metadata.namespace})` : ""}</span>
      </div>

      <!-- Right: Actions -->
      <div class="flex items-center gap-2">
        {#if activeTab === "editor"}
          <button
            class="flex h-[34px] items-center gap-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 font-mono text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
            onclick={handleSearch}
            title="Search (Cmd+F)"
          >
            <Search class="h-3.5 w-3.5" />
          </button>
          <button
            class="flex h-[34px] items-center gap-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 font-mono text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
            onclick={handleUndo}
            title="Undo (Cmd+Z)"
          >
            <Undo2 class="h-3.5 w-3.5" />
          </button>
          <button
            class="flex h-[34px] items-center gap-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 font-mono text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
            onclick={handleRedo}
            title="Redo (Cmd+Shift+Z)"
          >
            <Redo2 class="h-3.5 w-3.5" />
          </button>
        {/if}
        <button
          class="flex h-[34px] items-center gap-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 font-mono text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
          onclick={copyToClipboard}
        >
          {#if copied}
            <Check class="h-3.5 w-3.5 text-[var(--status-running)]" />
            <span>Copied</span>
          {:else}
            <Copy class="h-3.5 w-3.5" />
            <span>Copy</span>
          {/if}
        </button>
        {#if isModified}
          <button
            class="flex h-[34px] items-center gap-1.5 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 font-mono text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
            onclick={resetToOriginal}
            title="Reset to original"
          >
            <RotateCcw class="h-3.5 w-3.5" />
            <span>Reset</span>
          </button>
        {/if}
        <button
          class={cn(
            "flex h-[34px] items-center gap-1.5 rounded px-3.5 font-mono text-xs font-medium transition-opacity hover:opacity-90 disabled:opacity-50",
            isModified
              ? "bg-[var(--accent)] text-[var(--bg-primary)]"
              : "border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-muted)]"
          )}
          onclick={saveYaml}
          disabled={isSaving || !isModified}
        >
          {#if isSaving}
            <Loader2 class="h-3.5 w-3.5 animate-spin" />
            <span>Applying...</span>
          {:else}
            <Save class="h-3.5 w-3.5" />
            <span>Apply</span>
          {/if}
        </button>
      </div>
    </div>

    {#if saveError}
      <div class="shrink-0 border-b border-[var(--border-color)] bg-[var(--status-failed)]/10 px-4 py-2 text-[11px] text-[var(--status-failed)]">
        {saveError}
      </div>
    {/if}

    <!-- Tab bar -->
    <div class="flex h-[36px] shrink-0 items-center gap-0 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-2">
      <button
        class={cn(
          "flex items-center gap-1.5 rounded px-3 py-1.5 text-[11px] font-medium transition-colors",
          activeTab === "editor"
            ? "bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm"
            : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
        )}
        onclick={() => { activeTab = "editor"; }}
      >
        <Code class="h-3 w-3" />
        Editor
      </button>
      <button
        class={cn(
          "flex items-center gap-1.5 rounded px-3 py-1.5 text-[11px] font-medium transition-colors",
          activeTab === "history"
            ? "bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm"
            : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
        )}
        onclick={() => { activeTab = "history"; }}
      >
        <History class="h-3 w-3" />
        History
        {#if yamlHistory.length > 1}
          <span class="ml-0.5 rounded bg-[var(--bg-tertiary)] px-1 text-[9px] text-[var(--text-muted)]">{yamlHistory.length}</span>
        {/if}
      </button>
    </div>

    <!-- Content -->
    <div class="min-h-0 flex-1 overflow-hidden">
      {#if isLoading || (!cm && !cmLoadError)}
        <CodeSkeleton lines={30} lineHeight="h-3" spacing="space-y-[6px]" gutterPadding="px-3 py-2" contentPadding="p-2" fullHeight />
      {:else if cmLoadError}
        <div class="p-4 text-xs text-[var(--status-failed)]">{cmLoadError}</div>
      {:else if error}
        <div class="p-4 text-xs text-[var(--status-failed)]">{error}</div>
      {:else}
        <!-- Editor Tab -->
        <div class={cn("h-full", activeTab !== "editor" && "hidden")}>
          <div bind:this={editorContainer} class="h-full overflow-auto"></div>
        </div>

        <!-- History Tab -->
        <div class={cn("h-full", activeTab !== "history" && "hidden")}>
          <YamlHistoryPanel
            entries={yamlHistory}
            selectedIndex={selectedHistoryIndex}
            bind:diffContainer={historyDiffContainer}
            onselect={(i) => { selectedHistoryIndex = i; }}
            onrestore={restoreFromHistory}
          />
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* Dirty diff gutter: thin colored bar like VS Code */
  :global(.cm-dirty-diff-gutter) {
    width: 3px;
    min-width: 3px;
    border: none;
  }
  :global(.cm-dirty-diff-gutter .cm-gutterElement) {
    padding: 0 !important;
    min-width: 3px !important;
  }
  /* elementClass is applied to .cm-gutterElement itself, so background fills the line */
  :global(.cm-gutterElement.cm-dirty-added) {
    background: var(--status-running);
  }
  :global(.cm-gutterElement.cm-dirty-modified) {
    background: var(--accent);
  }
  :global(.cm-gutterElement.cm-dirty-deleted) {
    background: transparent;
    border-bottom: 2px solid var(--status-failed);
  }
</style>
