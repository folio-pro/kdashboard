export interface BulkDeleteState {
  showConfirm: boolean;
}

/**
 * Guard against the "Delete selected" button firing with nothing selected.
 * Returns the next showConfirm state — callers apply it to their own reactive store.
 */
export function handleBulkDelete(selectedCount: number): BulkDeleteState {
  // `<= 0` alone would let NaN through because every NaN comparison is false.
  if (!Number.isFinite(selectedCount) || selectedCount <= 0) {
    return { showConfirm: false };
  }
  return { showConfirm: true };
}

export interface ConfirmDeleteDeps {
  ondelete: () => void;
}

/**
 * Commit the bulk delete: invoke the consumer's delete handler and request the
 * confirmation dialog close. Callers apply the returned state.
 */
export function confirmDelete(deps: ConfirmDeleteDeps): BulkDeleteState {
  deps.ondelete();
  return { showConfirm: false };
}

/** Pluralize a resource label — trivial but used in multiple spots. */
export function pluralResource(n: number): "resource" | "resources" {
  return n === 1 ? "resource" : "resources";
}
