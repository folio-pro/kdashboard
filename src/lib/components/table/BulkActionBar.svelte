<script lang="ts">
  import BulkDeleteConfirm from "./BulkDeleteConfirm.svelte";
  import { Button } from "$lib/components/ui";
  import {
    confirmDelete as commitDelete,
    handleBulkDelete as computeShowConfirm,
  } from "./bulk-action-bar.logic";

  let {
    selectedCount,
    ondelete,
    ondeselect,
  }: {
    selectedCount: number;
    ondelete: () => void;
    ondeselect: () => void;
  } = $props();

  let showDeleteConfirm = $state(false);

  function handleBulkDelete() {
    showDeleteConfirm = computeShowConfirm(selectedCount).showConfirm;
  }

  function confirmDelete() {
    showDeleteConfirm = commitDelete({ ondelete }).showConfirm;
  }
</script>

{#if selectedCount > 0}
  <div class="flex items-center gap-3 rounded-sm bg-[var(--accent)]/10 px-4 py-2 mx-8 mb-2">
    <span class="text-[12px] font-medium text-[var(--text-primary)]">{selectedCount} {selectedCount === 1 ? 'resource' : 'resources'} selected</span>
    <Button variant="destructive" size="sm" onclick={handleBulkDelete}>
      Delete selected
    </Button>
    <Button variant="toolbar" size="sm" onclick={ondeselect}>
      Deselect all
    </Button>
  </div>
{/if}

<BulkDeleteConfirm
  open={showDeleteConfirm}
  {selectedCount}
  onconfirm={confirmDelete}
  oncancel={() => (showDeleteConfirm = false)}
/>
