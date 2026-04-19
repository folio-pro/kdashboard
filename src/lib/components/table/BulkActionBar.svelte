<script lang="ts">
  import ConfirmDialog from "$lib/components/common/ConfirmDialog.svelte";

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
    if (selectedCount === 0) return;
    showDeleteConfirm = true;
  }

  function confirmDelete() {
    showDeleteConfirm = false;
    ondelete();
  }
</script>

{#if selectedCount > 0}
  <div class="flex items-center gap-3 rounded bg-[var(--accent)]/10 px-4 py-2 mx-8 mb-2">
    <span class="text-xs font-medium text-[var(--text-primary)]">{selectedCount} {selectedCount === 1 ? 'resource' : 'resources'} selected</span>
    <button
      class="rounded border border-[var(--status-failed)]/30 bg-[var(--status-failed)]/10 px-3 py-1 text-xs font-medium text-[var(--status-failed)] hover:bg-[var(--status-failed)]/20 transition-colors"
      onclick={handleBulkDelete}
    >
      Delete selected
    </button>
    <button
      class="rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-1 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors"
      onclick={ondeselect}
    >
      Deselect all
    </button>
  </div>
{/if}

{#if showDeleteConfirm}
  <ConfirmDialog
    open={showDeleteConfirm}
    title="Delete {selectedCount} {selectedCount === 1 ? 'resource' : 'resources'}"
    description="This action cannot be undone. The selected resources will be permanently deleted from the cluster."
    confirmLabel="Delete {selectedCount} {selectedCount === 1 ? 'resource' : 'resources'}"
    cancelLabel="Keep resources"
    variant="destructive"
    onconfirm={confirmDelete}
    oncancel={() => (showDeleteConfirm = false)}
  />
{/if}
