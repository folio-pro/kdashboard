import type { Resource } from "$lib/types/index.js";

export interface CrdDetailState {
  /** What the detail renders: the live row, else the click-time snapshot. */
  resource: Resource | null;
  /** The object is gone from a settled list (deleted, or moved out of scope). */
  deleted: boolean;
}

/**
 * Resolve the open CRD detail against the live listing by uid. The listing is
 * `$state.raw` and replaced wholesale by every watch batch, so holding on to
 * the clicked row would freeze the detail at click time; looking it up again
 * lets each update flow through. The snapshot is only a fallback, so a
 * deleted object still shows what it last looked like, under a banner.
 * While a list is loading its rows are not final, so absence means nothing.
 */
export function resolveCrdDetail(
  items: readonly Resource[],
  uid: string | null,
  snapshot: Resource | null,
  loading: boolean,
): CrdDetailState {
  if (!uid) return { resource: null, deleted: false };
  const live = items.find((r) => r.metadata?.uid === uid);
  if (live) return { resource: live, deleted: false };
  return { resource: snapshot, deleted: !loading };
}
