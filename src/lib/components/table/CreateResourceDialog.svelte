<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "$lib/components/ui/dialog";
  import { Button, Select, SelectMenu, Spinner } from "$lib/components/ui";
  import { CodeSkeleton } from "$lib/components/ui/skeleton";
  import { ClipboardPaste, FilePlus2, CircleAlert, ArrowRight } from "lucide-svelte";
  import { k8sStore } from "$lib/stores/k8s.svelte";
  import { toastStore } from "$lib/stores/toast.svelte";
  import { loadCodeMirror, type CodeMirrorModules } from "$lib/utils/codemirror-lazy";
  import type { EditorView as EditorViewType } from "@codemirror/view";
  import { getExtensions } from "$lib/components/details/codemirror-extensions";
  import { initDiffMarkers, dirtyDiffCompartment } from "$lib/components/details/diff-tracking";
  import { summarizeManifests } from "./manifest-summary";
  import {
    TEMPLATE_KINDS,
    type TemplateKind,
    manifestTemplate,
    appendDocument,
    resolveTargets,
    needsNamespacePicker,
    applyButtonState,
    serializeForApply,
  } from "./create-resource.logic";

  /**
   * Create a resource from YAML written, pasted or templated by the user.
   *
   * The clipboard is read only when the user presses "Paste from clipboard":
   * the previous flow read it on every Create click and put its contents on
   * screen, which showed whatever the user last copied — private or not —
   * with a live "Apply to cluster" button under it. Nothing here touches the
   * clipboard, or the cluster, until an explicit click asks for it.
   *
   * Apply itself stays in the parent (ResourceTable): `onapply` receives one
   * serialized manifest per document, with the resolved namespace already
   * written in, and resolves to whether every one of them was accepted.
   */
  interface Props {
    onclose: () => void;
    onapply: (manifests: string[]) => Promise<boolean>;
  }

  let { onclose, onapply }: Props = $props();

  // Mounted only while open, so this starts true; it flips false only when
  // bits-ui closes itself (the X button), which we may need to undo.
  let open = $state(true);

  let draft = $state("");
  let chosenNamespace = $state("");
  let applying = $state(false);
  let askDiscard = $state(false);

  let cm = $state<CodeMirrorModules | null>(null);
  let cmLoadError = $state<string | null>(null);
  let editorContainer = $state<HTMLDivElement | null>(null);
  let editorView: EditorViewType | null = null;

  const context = $derived(k8sStore.currentContext);
  const currentNamespace = $derived(k8sStore.currentNamespace);
  const summary = $derived(summarizeManifests(draft));
  const targets = $derived(resolveTargets(summary.resources, currentNamespace, chosenNamespace));
  const showNamespacePicker = $derived(needsNamespacePicker(targets, currentNamespace));
  const apply = $derived(applyButtonState(summary, targets));
  const dirty = $derived(draft.trim().length > 0);

  // ---- editor -------------------------------------------------------------

  $effect(() => {
    if (cm || cmLoadError) return;
    loadCodeMirror()
      .then((modules) => {
        initDiffMarkers(modules);
        cm = modules;
      })
      .catch((err) => {
        cmLoadError = `Failed to load editor: ${err}`;
      });
  });

  $effect(() => {
    if (!cm || !editorContainer || editorView) return;
    const modules = cm;
    const parent = editorContainer;
    // The view is built once; later edits must not tear it down and rebuild it.
    const [initialDoc, namespace] = untrack(() => [draft, currentNamespace]);
    try {
      const view = new modules.EditorView({
        state: modules.EditorState.create({
          doc: initialDoc,
          extensions: [
            modules.keymap.of([{ key: "Mod-Enter", run: () => { void submit(); return true; } }]),
            ...getExtensions(modules, "", (c) => { draft = c; }, false, namespace),
          ],
        }),
        parent,
      });
      // Everything in a draft is "added" — the dirty-diff gutter would paint
      // every line green, which says nothing. Switch it off for this view.
      if (dirtyDiffCompartment) view.dispatch({ effects: dirtyDiffCompartment.reconfigure([]) });
      editorView = view;
      view.focus();
    } catch (err) {
      cmLoadError = `Failed to initialize editor: ${err}`;
    }
  });

  onDestroy(() => {
    editorView?.destroy();
    editorView = null;
  });

  /** Put `text` into the editor as a new document (or as the whole buffer when empty). */
  function insertDocument(text: string) {
    const next = appendDocument(editorView ? editorView.state.doc.toString() : draft, text);
    if (editorView) {
      editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: next } });
      editorView.focus();
    } else {
      draft = next;
    }
  }

  async function pasteFromClipboard() {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch (err) {
      toastStore.error("Cannot read clipboard", String(err));
      return;
    }
    if (!text.trim()) {
      toastStore.info("Clipboard is empty", "Copy a YAML manifest first");
      return;
    }
    insertDocument(text);
  }

  const templateItems = TEMPLATE_KINDS.map((kind: TemplateKind) => ({
    value: kind,
    label: kind,
    onSelect: () => insertDocument(manifestTemplate(kind, currentNamespace)),
  }));

  // ---- closing ------------------------------------------------------------

  /** Cancel / Escape / X / outside click all come through here. */
  function requestClose() {
    if (applying) return;
    if (dirty) {
      askDiscard = true;
      return;
    }
    onclose();
  }

  function discardDraft() {
    askDiscard = false;
    onclose();
  }

  // bits-ui already flipped `open` to false by the time this runs (the X
  // button drives it directly). When there is a draft to protect, put it back
  // before the DOM notices and ask instead.
  function handleOpenChange(value: boolean) {
    if (value) return;
    if (dirty && !applying) open = true;
    requestClose();
  }

  function handleEscape(e: KeyboardEvent) {
    if (askDiscard) {
      e.preventDefault();
      askDiscard = false;
      return;
    }
    if (dirty || applying) {
      e.preventDefault();
      requestClose();
    }
  }

  function handleInteractOutside(e: Event) {
    if (dirty || applying) {
      e.preventDefault();
      requestClose();
    }
  }

  // ---- apply --------------------------------------------------------------

  async function submit() {
    if (!apply.enabled || applying) return;
    applying = true;
    try {
      const manifests = targets.map(serializeForApply);
      const ok = await onapply(manifests);
      if (ok) {
        draft = "";
        onclose();
      }
    } finally {
      applying = false;
    }
  }
</script>

<Dialog bind:open onOpenChange={handleOpenChange}>
  <DialogContent
    class="flex max-h-[85vh] flex-col sm:max-w-[820px]"
    onEscapeKeydown={handleEscape}
    onInteractOutside={handleInteractOutside}
  >
    <DialogHeader>
      <div class="flex items-center gap-3">
        <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--accent)]/10">
          <FilePlus2 class="h-4 w-4 text-[var(--accent)]" />
        </div>
        <div class="flex flex-col gap-1">
          <DialogTitle>Create resource</DialogTitle>
          <DialogDescription class="text-[12px] text-[var(--text-muted)]">
            Write or paste a manifest. It is applied to
            <span class="font-mono text-[var(--text-secondary)]">{context || "the current cluster"}</span>{#if currentNamespace}, namespace <span class="font-mono text-[var(--text-secondary)]">{currentNamespace}</span>{/if}.
          </DialogDescription>
        </div>
      </div>
    </DialogHeader>

    <!-- Toolbar: template picker + explicit clipboard read -->
    <div class="flex flex-wrap items-center gap-2">
      <SelectMenu items={templateItems} value="" label="Insert template…" title="Insert a minimal manifest for a kind" />
      <Button variant="toolbar" size="sm" onclick={pasteFromClipboard} title="Read the clipboard and add it to the editor">
        <ClipboardPaste class="h-3.5 w-3.5" />
        Paste from clipboard
      </Button>
      {#if showNamespacePicker}
        <label class="ml-auto flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
          Apply into
          <Select size="sm" mono bind:value={chosenNamespace} aria-label="Target namespace">
            <option value="">Choose a namespace…</option>
            {#each k8sStore.namespaces as ns (ns)}
              <option value={ns}>{ns}</option>
            {/each}
          </Select>
        </label>
      {/if}
    </div>

    <!-- Editor -->
    <div class="relative h-[380px] min-h-0 shrink overflow-hidden rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)]">
      {#if cmLoadError}
        <div class="p-4 text-[12px] text-[var(--status-failed)]">{cmLoadError}</div>
      {:else if !cm}
        <CodeSkeleton lines={14} lineHeight="h-3" spacing="space-y-[6px]" gutterPadding="px-3 py-2" contentPadding="p-2" fullHeight />
      {/if}
      {#if cm && !cmLoadError}
        <div bind:this={editorContainer} class="h-full overflow-hidden"></div>
        {#if !dirty}
          <p class="pointer-events-none absolute left-14 top-2 text-[12px] text-[var(--text-muted)]">
            Start typing, insert a template, or paste from the clipboard.
          </p>
        {/if}
      {/if}
    </div>

    <!-- Live summary of what will be applied, and where -->
    <div class="flex min-h-[24px] flex-col gap-1.5 text-[11px]">
      {#if targets.length > 0}
        <div class="flex flex-wrap gap-1.5">
          {#each targets as t (t.resource.key)}
            <span
              class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 {t.needsNamespace
                ? 'border-[var(--status-warning)] bg-[var(--status-warning)]/10'
                : 'border-[var(--border-color)] bg-[var(--bg-secondary)]'}"
            >
              <span class="text-[var(--text-muted)]">{t.resource.kind}</span>
              <span class="font-mono text-[var(--text-primary)]">{t.resource.name}</span>
              {#if t.clusterScoped}
                <span class="text-[var(--text-muted)]">· cluster-scoped</span>
              {:else if t.needsNamespace}
                <span class="text-[var(--status-warning)]">· needs a namespace</span>
              {:else}
                <ArrowRight class="h-3 w-3 text-[var(--text-muted)]" />
                <span class="text-[var(--text-muted)]">namespace</span>
                <span class="font-mono {t.inferred ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'}" title={t.inferred ? "Not in the manifest — taken from the current selection" : "From the manifest"}>{t.namespace}</span>
              {/if}
            </span>
          {/each}
        </div>
      {/if}
      {#each summary.errors as err (err.index + err.message)}
        <p class="flex items-start gap-1.5 text-[var(--status-failed)]">
          <CircleAlert class="mt-px h-3 w-3 shrink-0" />
          <span>Document {err.index + 1}: {err.message}</span>
        </p>
      {/each}
    </div>

    <DialogFooter class="mt-1 items-center">
      {#if askDiscard}
        <div class="mr-auto flex items-center gap-2 text-[12px] text-[var(--text-secondary)]">
          <span>Discard draft?</span>
          <Button variant="outline" size="sm" onclick={() => { askDiscard = false; }}>Keep editing</Button>
          <Button variant="destructive" size="sm" onclick={discardDraft}>Discard</Button>
        </div>
      {/if}
      <Button variant="outline" size="md" onclick={requestClose} disabled={applying}>Cancel</Button>
      <Button
        variant="accent"
        size="md"
        onclick={submit}
        disabled={!apply.enabled || applying}
        title={apply.reason ?? "Apply (⌘↩)"}
      >
        {#if applying}
          <Spinner size="xs" />
          Applying…
        {:else}
          {apply.label}
        {/if}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
