<script lang="ts">
  import ConfirmDialog from "$lib/components/common/ConfirmDialog.svelte";

  // The bulk-delete confirmation is reached from two places — the
  // BulkActionBar button and the row context menu's bulk Delete — and both
  // must say exactly the same thing about an irreversible action. The copy
  // lives here once instead of being duplicated at each call site.
  let {
    open,
    selectedCount,
    onconfirm,
    oncancel,
  }: {
    open: boolean;
    selectedCount: number;
    onconfirm: () => void;
    oncancel: () => void;
  } = $props();

  let noun = $derived(selectedCount === 1 ? "resource" : "resources");
</script>

{#if open}
  <ConfirmDialog
    {open}
    title="Delete {selectedCount} {noun}"
    description="This action cannot be undone. The selected resources will be permanently deleted from the cluster."
    confirmLabel="Delete {selectedCount} {noun}"
    cancelLabel="Keep resources"
    variant="destructive"
    {onconfirm}
    {oncancel}
  />
{/if}
