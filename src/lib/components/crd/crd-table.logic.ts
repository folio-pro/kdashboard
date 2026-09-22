import type { Column, CrdColumn, Resource, SortDirection } from "$lib/types/index.js";
import { resolveJsonPath } from "$lib/utils/k8s-helpers";
import { sortResources } from "../table/resource-table";

/**
 * Pure logic behind CrdTableView: columns, filter, sort, keyboard focus and
 * the row menu. The view keeps its per-tab state (filter text, sort, focused
 * row) on the Tab through the same uiStore getters ResourceTable uses; the
 * column set is not the built-in one because it comes from the CRD's
 * additionalPrinterColumns.
 */

/** Printer columns are keyed by position: two may share a name, never a slot. */
const PRINTER_KEY = "crd:";

function printerIndex(key: string): number {
  return key.startsWith(PRINTER_KEY) ? Number(key.slice(PRINTER_KEY.length)) : -1;
}

/** Name, (Namespace), one column per printer column, Age — all sortable. */
export function crdTableColumns(printer: CrdColumn[], opts: { showNamespace: boolean }): Column[] {
  const cols: Column[] = [{ key: "name", label: "Name", sortable: true }];
  if (opts.showNamespace) cols.push({ key: "namespace", label: "Namespace", sortable: true, width: "150px" });
  printer.forEach((c, i) => cols.push({ key: `${PRINTER_KEY}${i}`, label: c.name, sortable: true }));
  cols.push({ key: "age", label: "Age", sortable: true, width: "80px" });
  return cols;
}

/** The printer column behind a column key, if it is one. */
export function printerColumnFor(key: string, printer: CrdColumn[]): CrdColumn | undefined {
  const i = printerIndex(key);
  return i >= 0 ? printer[i] : undefined;
}

/** A printer column's value for a row, as text; "" when absent. */
export function crdCellText(resource: Resource, key: string, printer: CrdColumn[]): string {
  const col = printerColumnFor(key, printer);
  return col ? resolveJsonPath(resource, col.json_path) : "";
}

/** Case-insensitive match on name, namespace and every printer column. */
export function filterCrdResources(items: Resource[], text: string, printer: CrdColumn[]): Resource[] {
  if (!text) return items;
  const lower = text.toLowerCase();
  return items.filter(
    (r) =>
      r.metadata.name.toLowerCase().includes(lower) ||
      (r.metadata.namespace ?? "").toLowerCase().includes(lower) ||
      printer.some((c) => resolveJsonPath(r, c.json_path).toLowerCase().includes(lower)),
  );
}

const NUMERIC_TYPES = new Set(["integer", "number"]);
const collator = new Intl.Collator(undefined, { numeric: true });

/**
 * Sort by name / namespace / age exactly like the built-in tables (shared
 * `sortResources`, age newest-first on "asc"), or by a printer column —
 * numerically for integer/number columns, so 10 sorts after 2. Missing values
 * sort last in either direction. Unknown keys fall back to name.
 */
export function sortCrdResources(
  items: Resource[],
  printer: CrdColumn[],
  sortColumn: string,
  sortDirection: SortDirection,
): Resource[] {
  const col = printerColumnFor(sortColumn, printer);
  if (!col) {
    const builtIn = sortColumn === "namespace" || sortColumn === "age" ? sortColumn : "name";
    return sortResources(items, builtIn, sortDirection);
  }
  const numeric = NUMERIC_TYPES.has(col.column_type);
  const sign = sortDirection === "asc" ? 1 : -1;
  const keyed = items.map((r) => ({ r, v: resolveJsonPath(r, col.json_path) }));
  keyed.sort((a, b) => {
    if (a.v === "" || b.v === "") return a.v === b.v ? 0 : a.v === "" ? 1 : -1;
    if (numeric) {
      const d = Number(a.v) - Number(b.v);
      if (!Number.isNaN(d) && d !== 0) return sign * d;
    }
    return sign * collator.compare(a.v, b.v);
  });
  return keyed.map((k) => k.r);
}

/**
 * The next keyboard-focused row for j/k (delta +1/-1): the first key press
 * lands on the first row, then moves clamp at both ends. -1 with no rows.
 */
export function moveRowIndex(current: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.min(current, count - 1) + delta));
}

export interface CrdRowActionDeps {
  open: (resource: Resource) => void;
  /** Copy `produce()`'s text, reporting it under `label`. */
  copy: (label: string, produce: () => string | Promise<string>) => void | Promise<void>;
  /** The object's full YAML, from the cluster (the row is a list projection). */
  fetchYaml: (resource: Resource) => Promise<string>;
  /** Ask to delete (the caller confirms). */
  remove: (resource: Resource) => void;
}

export interface CrdRowAction {
  id: "open" | "copy-name" | "copy-namespace" | "copy-yaml" | "copy-json" | "delete";
  label: string;
  execute: () => void;
}

/** The right-click menu of a CRD row, in display order. */
export function crdRowActions(resource: Resource, deps: CrdRowActionDeps): CrdRowAction[] {
  const actions: CrdRowAction[] = [
    { id: "open", label: "Open details", execute: () => deps.open(resource) },
    { id: "copy-name", label: "Copy name", execute: () => void deps.copy("Name", () => resource.metadata.name) },
  ];
  const ns = resource.metadata.namespace;
  if (ns) actions.push({ id: "copy-namespace", label: "Copy namespace", execute: () => void deps.copy("Namespace", () => ns) });
  actions.push(
    { id: "copy-yaml", label: "Copy as YAML", execute: () => void deps.copy("YAML", () => deps.fetchYaml(resource)) },
    { id: "copy-json", label: "Copy as JSON", execute: () => void deps.copy("JSON", () => JSON.stringify(resource, null, 2)) },
    { id: "delete", label: "Delete…", execute: () => deps.remove(resource) },
  );
  return actions;
}
