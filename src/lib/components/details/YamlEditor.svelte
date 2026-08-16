<script lang="ts">
  import { onDestroy } from "svelte";
  import { cn } from "$lib/utils";
  import { Badge, Button, Spinner } from "$lib/components/ui";
  import {
    Copy,
    Check,
    Save,
    Undo2,
    Redo2,
    RotateCcw,
    History,
    Code,
    Search,
    CircleAlert,
    TriangleAlert,
  } from "lucide-svelte";
  import { invoke } from "$lib/ipc/core";
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

  // Live diagnostic counts, fed by the editor's update listener.
  let errorCount = $state<number>(0);
  let warningCount = $state<number>(0);

  function initEditor(modules: CodeMirrorModules) {
    if (!editorContainer || editorView) return;

    editorView = new modules.EditorView({
      state: modules.EditorState.create({
        doc: originalYaml,
        extensions: getExtensions(
          modules,
          originalYaml,
          (c) => { currentContent = c; },
          false,
          resource?.metadata.namespace ?? "",
          (errors, warnings) => { errorCount = errors; warningCount = warnings; },
        ),
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

  // Key the reload on the resource's IDENTITY, not the object reference:
  // selectedResource is reassigned on every Applied watch event for this uid,
  // and reloading then would tear down and rebuild the whole CodeMirror editor
  // (plus an IPC round-trip) per status churn — discarding in-progress edits.
  let loadedKey: string | undefined;
  $effect(() => {
    if (!resource) return;
    const key =
      resource.metadata?.uid ??
      `${resource.kind}/${resource.metadata?.namespace ?? ""}/${resource.metadata?.name ?? ""}`;
    if (key !== loadedKey) {
      loadedKey = key;
      loadYaml(resource);
    }
  });

  // Initialize editor when tab changes and CodeMirror is loaded
  $effect(() => {
    if (activeTab === "editor" && !isLoading && !error && cm) {
      const modules = cm;
      requestAnimationFrame(() => {
        if (!editorView && editorContainer) {
          // Surface failures — an uncaught throw here (e.g. mismatched
          // CodeMirror package instances) would otherwise leave a silently
          // blank panel.
          try {
            initEditor(modules);
          } catch (err) {
            cmLoadError = `Failed to initialize editor: ${err}`;
          }
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
        try {
          initHistoryDiffView(modules, compareWith, entry.yaml);
        } catch (err) {
          cmLoadError = `Failed to initialize editor: ${err}`;
        }
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
    // Counts belong to the destroyed view; leaving them set would keep Apply
    // disabled for the next resource until its first lint pass lands.
    errorCount = 0;
    warningCount = 0;

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
      // A failed load must stay retryable: clear the identity key so the next
      // watch event (or re-selection) for this resource triggers a fresh load
      // instead of being skipped as "already loaded".
      loadedKey = undefined;
    } finally {
      isLoading = false;
    }
  }

  async function saveYaml() {
    // `errorCount` trails the document by the linter's debounce, so a fast
    // edit-then-Apply could otherwise slip invalid YAML past the disabled
    // state. Re-lint exactly what is about to be sent.
    if (cm) {
      const blocking = cm.lintYaml(currentContent).filter((d) => d.severity === "error");
      if (blocking.length > 0) {
        errorCount = blocking.length;
        saveError = `Not applied — fix ${blocking.length} error${blocking.length === 1 ? "" : "s"} first: ${blocking[0].message}`;
        return;
      }
    }

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

  function handleShowProblems() {
    if (editorView && cm) cm.openLintPanel(editorView);
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
    {#if saveError}
      <div class="shrink-0 border-b border-[var(--border-color)] bg-[var(--status-failed)]/10 px-4 py-2 text-[11px] text-[var(--status-failed)]">
        {saveError}
      </div>
    {/if}

    <!-- Tab bar -->
    <div class="flex h-[36px] shrink-0 items-center gap-0 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-2">
      <Button
        variant="segment"
        size="xs"
        active={activeTab === "editor"}
        activeStyle="raised"
        class="px-3"
        onclick={() => { activeTab = "editor"; }}
      >
        <Code class="h-3 w-3" />
        Editor
      </Button>
      <Button
        variant="segment"
        size="xs"
        active={activeTab === "history"}
        activeStyle="raised"
        class="px-3"
        onclick={() => { activeTab = "history"; }}
      >
        <History class="h-3 w-3" />
        History
        {#if yamlHistory.length > 1}
          <Badge appearance="surface" tone="muted" class="ml-0.5 px-1">{yamlHistory.length}</Badge>
        {/if}
      </Button>

      <!-- Status and every editor action, sized to sit inside the 36px strip.
           The resource's identity is not repeated here: DetailPanel already
           shows the name, kind and namespace directly above this component. -->
      <div class="ml-auto flex items-center gap-0.5">
        {#if isModified}
          <Badge tone="warning" class="mr-1 font-semibold">MODIFIED</Badge>
        {/if}
        {#if saveSuccess}
          <Badge tone="success" class="mr-1 font-semibold">SAVED</Badge>
        {/if}
        {#if activeTab === "editor" && errorCount > 0}
          <Button
            variant="soft-tone"
            tone="error"
            size="inline-xs"
            class="mr-1 px-1.5 py-0.5 font-semibold"
            onclick={handleShowProblems}
            title="Show problems (F8)"
            aria-label="Show problems: {errorCount} error{errorCount === 1 ? '' : 's'}"
          >
            <CircleAlert class="h-2.5 w-2.5" />
            {errorCount}
          </Button>
        {/if}
        {#if activeTab === "editor" && warningCount > 0}
          <Button
            variant="soft-tone"
            tone="warning"
            size="inline-xs"
            class="mr-1 px-1.5 py-0.5 font-semibold"
            onclick={handleShowProblems}
            title="Show problems (F8)"
            aria-label="Show problems: {warningCount} warning{warningCount === 1 ? '' : 's'}"
          >
            <TriangleAlert class="h-2.5 w-2.5" />
            {warningCount}
          </Button>
        {/if}

        {#if activeTab === "editor"}
          <Button
            variant="muted"
            size="icon-xs"
            onclick={handleSearch}
            title="Search (Cmd+F)"
            aria-label="Search"
          >
            <Search class="h-3 w-3" />
          </Button>
          <Button
            variant="muted"
            size="icon-xs"
            onclick={handleUndo}
            title="Undo (Cmd+Z)"
            aria-label="Undo"
          >
            <Undo2 class="h-3 w-3" />
          </Button>
          <Button
            variant="muted"
            size="icon-xs"
            onclick={handleRedo}
            title="Redo (Cmd+Shift+Z)"
            aria-label="Redo"
          >
            <Redo2 class="h-3 w-3" />
          </Button>
        {/if}
        <Button variant="muted" size="xs" onclick={copyToClipboard} title="Copy YAML to clipboard">
          {#if copied}
            <Check class="h-3 w-3 text-[var(--status-running)]" />
            <span>Copied</span>
          {:else}
            <Copy class="h-3 w-3" />
            <span>Copy</span>
          {/if}
        </Button>

        {#if isModified}
          <Button variant="muted" size="xs" onclick={resetToOriginal} title="Reset to original">
            <RotateCcw class="h-3 w-3" />
            <span>Reset</span>
          </Button>
        {/if}
        <Button
          variant={isModified && errorCount === 0 ? "accent" : "outline"}
          size="xs"
          class="ml-1 px-2.5 font-semibold"
          onclick={saveYaml}
          disabled={isSaving || !isModified || errorCount > 0}
          title={errorCount > 0 ? "Fix the YAML errors before applying" : "Apply to cluster"}
        >
          {#if isSaving}
            <Spinner size="xs" />
            <span>Applying...</span>
          {:else}
            <Save class="h-3 w-3" />
            <span>Apply</span>
          {/if}
        </Button>
      </div>
    </div>

    <!-- Content -->
    <div class="min-h-0 flex-1 overflow-hidden">
      {#if isLoading || (!cm && !cmLoadError)}
        <CodeSkeleton lines={30} lineHeight="h-3" spacing="space-y-[6px]" gutterPadding="px-3 py-2" contentPadding="p-2" fullHeight />
      {:else if cmLoadError}
        <div class="p-4 text-[12px] text-[var(--status-failed)]">{cmLoadError}</div>
      {:else if error}
        <div class="p-4 text-[12px] text-[var(--status-failed)]">{error}</div>
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
