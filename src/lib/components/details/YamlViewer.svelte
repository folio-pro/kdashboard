<script lang="ts">
  import { cn, escapeHtml, kindToResourceType } from "$lib/utils";
  import { Button } from "$lib/components/ui/button";
  import { ScrollArea } from "$lib/components/ui/scroll-area";
  import { Copy, Check, Loader2, Pencil, Save } from "lucide-svelte";
  import { CodeSkeleton } from "$lib/components/ui/skeleton";
  import { invoke } from "@tauri-apps/api/core";
  import type { Resource } from "$lib/types";

  interface Props {
    resource: Resource;
  }

  let { resource }: Props = $props();

  let yaml = $state<string>("");
  let isLoading = $state<boolean>(true);
  let error = $state<string | null>(null);
  let copied = $state<boolean>(false);

  let editMode = $state<boolean>(false);
  let editedContent = $state<string>("");
  let isSaving = $state<boolean>(false);
  let saveError = $state<string | null>(null);

  let isModified = $derived(editMode && editedContent !== yaml);

  $effect(() => {
    const r = resource;
    loadYaml(r);
  });

  async function loadYaml(r: Resource) {
    isLoading = true;
    error = null;
    editMode = false;
    saveError = null;
    try {
      const result = await invoke<string>("get_resource_yaml", {
        resourceType: kindToResourceType(r.kind),
        name: r.metadata.name,
        namespace: r.metadata.namespace ?? "",
      });
      yaml = result;
    } catch (err) {
      error = `Failed to load YAML: ${err}`;
      yaml = "";
    } finally {
      isLoading = false;
    }
  }

  function enterEditMode() {
    editedContent = yaml;
    saveError = null;
    editMode = true;
  }

  function cancelEdit() {
    editMode = false;
    editedContent = "";
    saveError = null;
  }

  async function saveYaml() {
    isSaving = true;
    saveError = null;
    try {
      await invoke("apply_yaml", { yaml: editedContent });
      yaml = editedContent;
      editMode = false;
    } catch (err) {
      saveError = `Failed to apply YAML: ${err}`;
    } finally {
      isSaving = false;
    }
  }

  async function copyToClipboard() {
    try {
      await navigator.clipboard.writeText(editMode ? editedContent : yaml);
      copied = true;
      setTimeout(() => {
        copied = false;
      }, 2000);
    } catch {
      // fallback
    }
  }

  function highlightYaml(text: string): string {
    return text
      .split("\n")
      .map((line) => {
        if (line.trimStart().startsWith("#")) {
          return `<span class="yaml-comment">${escapeHtml(line)}</span>`;
        }

        const kvMatch = line.match(/^(\s*)([\w.-]+)(:)(.*)/);
        if (kvMatch) {
          const [, indent, key, colon, value] = kvMatch;
          let valueHtml = escapeHtml(value);
          const trimmedValue = value.trim();

          if (trimmedValue === "true" || trimmedValue === "false") {
            valueHtml = ` <span class="yaml-bool">${trimmedValue}</span>`;
          } else if (/^\d+$/.test(trimmedValue)) {
            valueHtml = ` <span class="yaml-number">${trimmedValue}</span>`;
          } else if (trimmedValue.startsWith('"') || trimmedValue.startsWith("'")) {
            valueHtml = ` <span class="yaml-string">${escapeHtml(trimmedValue)}</span>`;
          } else if (trimmedValue !== "") {
            valueHtml = ` <span class="text-[var(--text-secondary)]">${escapeHtml(trimmedValue)}</span>`;
          }

          return `${escapeHtml(indent)}<span class="yaml-key">${escapeHtml(key)}</span><span class="yaml-punctuation">${colon}</span>${valueHtml}`;
        }

        const listMatch = line.match(/^(\s*)(- )(.*)/);
        if (listMatch) {
          const [, indent, dash, rest] = listMatch;
          return `${escapeHtml(indent)}<span class="yaml-punctuation">${dash}</span><span class="text-[var(--text-secondary)]">${escapeHtml(rest)}</span>`;
        }

        return escapeHtml(line);
      })
      .join("\n");
  }


  let highlightedYaml = $derived(highlightYaml(yaml));
  let lineCount = $derived(yaml.split("\n").length);
</script>

<div class="flex h-full flex-col">
  <!-- Toolbar -->
  <div class="flex items-center justify-between border-b border-[var(--border-color)] px-4 py-1.5">
    <div class="flex items-center gap-2">
      <span class="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">YAML</span>
      {#if isModified}
        <span class="rounded bg-[var(--status-warning)]/15 px-1.5 py-0.5 text-[9px] font-medium text-[var(--status-warning)]">Edited</span>
      {/if}
    </div>
    <div class="flex items-center gap-1">
      <Button
        variant="ghost"
        size="sm"
        class="h-6 gap-1.5 px-2 text-[10px] text-[var(--text-muted)]"
        onclick={copyToClipboard}
      >
        {#if copied}
          <Check class="h-3 w-3 text-[var(--status-running)]" />
          <span>Copied</span>
        {:else}
          <Copy class="h-3 w-3" />
          <span>Copy</span>
        {/if}
      </Button>
      {#if !editMode}
        <Button
          variant="ghost"
          size="sm"
          class="h-6 gap-1.5 px-2 text-[10px] text-[var(--text-muted)]"
          onclick={enterEditMode}
          disabled={isLoading || !!error}
        >
          <Pencil class="h-3 w-3" />
          <span>Edit</span>
        </Button>
      {:else}
        <Button
          variant="ghost"
          size="sm"
          class="h-6 gap-1.5 px-2 text-[10px] text-[var(--text-muted)]"
          onclick={saveYaml}
          disabled={isSaving}
        >
          {#if isSaving}
            <Loader2 class="h-3 w-3 animate-spin" />
          {:else}
            <Save class="h-3 w-3" />
          {/if}
          <span>Save</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          class="h-6 gap-1.5 px-2 text-[10px] text-[var(--text-muted)]"
          onclick={cancelEdit}
          disabled={isSaving}
        >
          <span>Cancel</span>
        </Button>
      {/if}
    </div>
  </div>

  {#if saveError}
    <div class="border-b border-[var(--border-color)] bg-[var(--status-failed)]/10 px-4 py-1.5 text-[11px] text-[var(--status-failed)]">
      {saveError}
    </div>
  {/if}

  <!-- Content -->
  <div class="flex-1 overflow-auto">
    {#if isLoading}
      <CodeSkeleton lines={20} lineHeight="h-2.5" />
    {:else if error}
      <div class="p-4 text-xs text-[var(--status-failed)]">{error}</div>
    {:else if editMode}
      <textarea
        class="h-full w-full resize-none bg-[var(--bg-primary)] p-3 font-mono text-[13px] leading-relaxed text-[var(--text-primary)] outline-none"
        bind:value={editedContent}
        spellcheck="false"
        disabled={isSaving}
      ></textarea>
    {:else}
      <div class="flex">
        <!-- Line Numbers -->
        <div class="shrink-0 select-none border-r border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-3 text-right font-mono text-[10px] leading-relaxed text-[var(--text-muted)]">
          {#each Array(lineCount) as _, i}
            <div>{i + 1}</div>
          {/each}
        </div>
        <!-- Code -->
        <pre class="flex-1 overflow-x-auto p-3 font-mono text-[11px] leading-relaxed"><code>{@html highlightedYaml}</code></pre>
      </div>
    {/if}
  </div>
</div>
