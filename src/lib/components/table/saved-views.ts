// Saved views: a named filter set you come back to instead of retyping.
//
// Each resource type ships a few built-ins (the questions people ask of that
// table every day); the user adds their own from the current filter state and
// they persist in settings. A view is "active" when the tab's filter state
// equals it exactly, so the built-in "All" lights up whenever no filter is on.

import type { FilterState, SavedView } from "$lib/types/ui";
import { sameFacets } from "$lib/utils/facets";

export type { SavedView, FilterState };

const ALL: Omit<SavedView, "resourceType"> = { id: "all", name: "All", facets: [], text: "", statFilter: null, builtin: true };

const BUILTINS: Record<string, Array<Omit<SavedView, "resourceType">>> = {
  pods: [
    ALL,
    { id: "attention", name: "Attention", facets: [], text: "", statFilter: "needsAttention", builtin: true },
    { id: "restarting", name: "Restarting", facets: [{ key: "restarts", op: ">", value: "0" }], text: "", statFilter: null, builtin: true },
  ],
  deployments: [
    ALL,
    { id: "degraded", name: "Degraded", facets: [], text: "", statFilter: "degraded", builtin: true },
  ],
  nodes: [
    ALL,
    { id: "not-ready", name: "Not ready", facets: [], text: "", statFilter: "notReady", builtin: true },
  ],
  events: [
    ALL,
    { id: "warnings", name: "Warnings", facets: [], text: "", statFilter: "warning", builtin: true },
  ],
};

export function builtinViews(resourceType: string): SavedView[] {
  const list = BUILTINS[resourceType] ?? [ALL];
  return list.map((v) => ({ ...v, resourceType }));
}

/** Built-ins first, then the user's own for this type, in saved order. */
export function viewsFor(resourceType: string, saved: SavedView[] | undefined): SavedView[] {
  const custom = (saved ?? []).filter((v) => v.resourceType === resourceType);
  return [...builtinViews(resourceType), ...custom];
}

export function isViewActive(view: SavedView, state: FilterState): boolean {
  return (
    (view.statFilter ?? null) === (state.statFilter ?? null) &&
    (view.text ?? "") === (state.text ?? "") &&
    sameFacets(view.facets ?? [], state.facets ?? [])
  );
}

/** A view built from what the tab currently filters on. */
export function viewFromState(name: string, resourceType: string, state: FilterState): SavedView {
  return {
    id: `${resourceType}-${Date.now().toString(36)}`,
    name: name.trim(),
    resourceType,
    facets: state.facets.map((f) => ({ ...f })),
    text: state.text,
    statFilter: state.statFilter ?? null,
  };
}

/** Nothing to save when the state is the built-in "All". */
export function isEmptyState(state: FilterState): boolean {
  return state.facets.length === 0 && !state.text && !state.statFilter;
}
