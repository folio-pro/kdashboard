<script lang="ts">
  import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { FileWarning } from "lucide-svelte";
  import { summarizeManifests } from "./manifest-summary";

  /**
   * "Create" reads whatever happens to be on the clipboard and applies it to
   * the live cluster. It used to do that with no preview and no confirmation:
   * the most consequential action in the app, behind its most inviting button,
   * acting on content the user could not see. This shows what will be applied
   * and where before anything is sent.
   */
  interface Props {
    open: boolean;
    yaml: string;
    context: string;
    namespace: string;
    onapply: () => void;
    oncancel: () => void;
  }

  let { open, yaml, context, namespace, onapply, oncancel }: Props = $props();

  let summary = $derived(summarizeManifests(yaml));

  function handleOpenChange(value: boolean) {
    if (!value) oncancel();
  }
</script>

<Dialog {open} onOpenChange={handleOpenChange}>
  <DialogContent class="sm:max-w-[600px]">
    <DialogHeader>
      <div class="flex items-center gap-3">
        <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--status-warning)]/10">
          <FileWarning class="h-4 w-4 text-[var(--status-warning)]" />
        </div>
        <div class="flex flex-col gap-1">
          <DialogTitle>Apply clipboard YAML?</DialogTitle>
          <DialogDescription class="text-[12px] text-[var(--text-muted)]">
            This writes to <span class="font-mono text-[var(--text-secondary)]">{context || "the current cluster"}</span>{#if namespace}, namespace <span class="font-mono text-[var(--text-secondary)]">{namespace}</span>{/if}.
          </DialogDescription>
        </div>
      </div>
    </DialogHeader>

    {#if summary.resources.length > 0}
      <div class="mt-3 flex flex-wrap gap-1.5">
        {#each summary.resources as r (r.key)}
          <span class="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-0.5 text-[11px]">
            <span class="text-[var(--text-muted)]">{r.kind}</span>
            <span class="font-mono text-[var(--text-primary)]">{r.name}</span>
          </span>
        {/each}
      </div>
    {:else}
      <p class="mt-3 text-[11px] text-[var(--status-warning)]">
        No <span class="font-mono">kind</span> field found — this may not be a Kubernetes manifest.
      </p>
    {/if}

    <pre class="mt-3 max-h-[300px] select-text overflow-auto rounded-md border border-[var(--border-color)] bg-[var(--bg-secondary)] p-3 font-mono text-[11px] leading-relaxed text-[var(--text-secondary)]">{yaml}</pre>

    <DialogFooter class="mt-4">
      <Button variant="outline" size="sm" onclick={oncancel}>Cancel</Button>
      <Button variant="default" size="sm" onclick={onapply}>
        Apply {summary.resources.length > 1 ? `${summary.resources.length} resources` : "to cluster"}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
