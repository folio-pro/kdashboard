<script lang="ts">
  import { Columns3, RotateCcw } from "lucide-svelte";
  import { Button } from "$lib/components/ui";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { Popover, PopoverTrigger, PopoverContent } from "$lib/components/ui/popover";
  import { cn } from "$lib/utils";
  import type { Column } from "$lib/types";
  import { tablePrefs } from "./table-prefs.svelte";

  /** Show/hide columns for one resource type. Name cannot be hidden. */
  interface Props {
    resourceType: string;
    /** Every column the type defines, shown or hidden. */
    allColumns: Column[];
    /** Namespace is hidden by the table itself while one namespace is selected. */
    namespaceAutoHidden: boolean;
  }

  let { resourceType, allColumns, namespaceAutoHidden }: Props = $props();

  let open = $state(false);
  let hiddenCount = $derived(tablePrefs.hiddenCount(resourceType));
</script>

<Popover bind:open>
  <PopoverTrigger>
    {#snippet child({ props })}
      <Button
        {...props}
        variant="ghost"
        size="icon-sm"
        class={cn("relative text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]", hiddenCount > 0 && "text-[var(--text-primary)]")}
        title="Columns"
        aria-label="Choose columns"
      >
        <Columns3 class="h-3.5 w-3.5" />
        {#if hiddenCount > 0}
          <span class="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-[var(--accent)]" aria-hidden="true"></span>
        {/if}
      </Button>
    {/snippet}
  </PopoverTrigger>
  <PopoverContent align="end" class="w-[220px] p-1">
    <div class="flex items-center justify-between px-2 py-1.5">
      <span class="text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--text-muted)]">Columns</span>
      {#if hiddenCount > 0}
        <Button variant="muted" size="inline-xs" onclick={() => tablePrefs.resetColumns(resourceType)}>
          <RotateCcw class="h-2.5 w-2.5" />
          Reset
        </Button>
      {/if}
    </div>
    <div class="flex max-h-[320px] flex-col overflow-y-auto">
      {#each allColumns as column (column.key)}
        {@const locked = column.key === "name"}
        {@const autoHidden = column.key === "namespace" && namespaceAutoHidden}
        <label
          class={cn(
            "flex h-7 cursor-pointer items-center gap-2 rounded-sm px-2 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--sidebar-hover)]",
            (locked || autoHidden) && "cursor-default opacity-60"
          )}
          title={autoHidden ? "Hidden while one namespace is selected" : undefined}
        >
          <Checkbox
            checked={!tablePrefs.isHidden(resourceType, column.key, column.defaultHidden) && !autoHidden}
            disabled={locked || autoHidden}
            onCheckedChange={() => tablePrefs.toggleColumn(resourceType, column.key)}
            aria-label="Show {column.label} column"
          />
          <span class="flex-1 truncate">{column.label}</span>
          {#if autoHidden}
            <span class="text-[10px] text-[var(--text-muted)]">auto</span>
          {/if}
        </label>
      {/each}
    </div>
  </PopoverContent>
</Popover>
