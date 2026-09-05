import { k8sStore } from "./stores/k8s.svelte.js";
import { uiStore } from "./stores/ui.svelte.js";
import { contextMenuStore } from "./stores/context-menu.svelte.js";
import { dialogStore } from "./stores/dialogs.svelte.js";
import { agentStore } from "./stores/agent.svelte.js";
import { SCALABLE_TYPES } from "./actions/registry.js";
import { isInputElement, overlayOpen } from "./utils/dom.js";
import type { ActiveView } from "./stores/ui.svelte.js";

/**
 * Single source of truth for keyboard shortcuts.
 *
 * Three consumers read this list and nothing else:
 *   - `utils/keyboard.ts` dispatches on it,
 *   - `common/StatusBar.svelte` renders the contextual hint strip from it,
 *   - `settings/ShortcutsTab.svelte` renders the full reference from it.
 *
 * Before this existed the three drifted: the status bar advertised a `d`
 * (Delete) binding nothing implemented, `s` (Scale) was implemented but
 * advertised nowhere, and the settings tab listed six of the fourteen.
 */

export type ShortcutScope = "global" | "table" | "details";

export interface Shortcut {
  id: string;
  /** Display form — rendered inside a <kbd> by both consumers. */
  keys: string;
  label: string;
  scope: ShortcutScope;
  /**
   * Matches the raw event. `meta` is metaKey||ctrlKey, resolved once by the
   * dispatcher so each entry doesn't repeat the platform check.
   */
  match: (e: KeyboardEvent, meta: boolean) => boolean;
  run: (e: KeyboardEvent) => void;
  /** Live (and advertised) only when this returns true. Default: always. */
  enabled?: () => boolean;
  /** Still fires while focus is in a text input. Default: false. */
  allowInInput?: boolean;
  /**
   * Owned by a component's own handler rather than the global dispatcher
   * (j/k/Enter belong to ResourceTable, which knows the filtered row list).
   * Listed here purely so the hints stay in one place.
   */
  handledElsewhere?: boolean;
  /** Hide from the status-bar strip — it stays in the settings reference. */
  hideHint?: boolean;
}

const selectedKind = (): string => (k8sStore.selectedResource?.kind ?? "").toLowerCase();

/** Escape unwinds the UI in priority order: overlay, then view, then selection. */
export function runEscape(target: EventTarget | null, isInput: boolean): void {
  if (overlayOpen()) return;
  if (contextMenuStore.open) {
    contextMenuStore.close();
    return;
  }
  if (uiStore.commandPaletteOpen) {
    uiStore.commandPaletteOpen = false;
    return;
  }
  if (uiStore.activeView === "settings") {
    uiStore.backToPrevious();
    return;
  }
  if (isInput) {
    (target as HTMLElement).blur();
    return;
  }
  const view = uiStore.activeView;
  if (view === "logs" || view === "terminal" || view === "yaml") {
    if (uiStore.activeTab?.closable) uiStore.closeTab(uiStore.activeTabId);
    return;
  }
  if (view === "details") {
    if (k8sStore.navigateBack()) return;
    k8sStore.selectResource(null);
    if (uiStore.activeTab?.closable) uiStore.closeTab(uiStore.activeTabId);
    return;
  }
  if (view !== "table") {
    uiStore.backToTable();
    return;
  }
  if (uiStore.previewOpen) {
    uiStore.previewOpen = false;
    return;
  }
  if (uiStore.selectedRowIndex >= 0) uiStore.resetSelection();
}

export const SHORTCUTS: Shortcut[] = [
  // --- Global ---------------------------------------------------------------
  {
    id: "command-palette",
    keys: "⌘K",
    label: "Command Palette",
    scope: "global",
    allowInInput: true,
    match: (e, meta) => meta && e.key === "k",
    run: () => uiStore.toggleCommandPalette(),
  },
  {
    id: "close-tab",
    keys: "⌘W",
    label: "Close Tab",
    scope: "global",
    allowInInput: true,
    hideHint: true,
    match: (e, meta) => meta && e.key === "w",
    run: () => {
      if (uiStore.activeTab?.closable) uiStore.closeTab(uiStore.activeTabId);
    },
  },
  {
    id: "toggle-logs",
    keys: "⌘L",
    label: "Logs",
    scope: "global",
    allowInInput: true,
    hideHint: true,
    match: (e, meta) => meta && e.key === "l",
    run: () => {
      if (uiStore.activeView === "logs") uiStore.backToPrevious();
      else uiStore.showLogs();
    },
  },
  {
    id: "toggle-terminal",
    keys: "⌘T",
    label: "Terminal",
    scope: "global",
    allowInInput: true,
    hideHint: true,
    match: (e, meta) => meta && e.key === "t",
    run: () => {
      if (uiStore.activeView === "terminal") uiStore.backToPrevious();
      else uiStore.showTerminal();
    },
  },
  {
    id: "toggle-agent",
    keys: "⌘J",
    label: "AI Agent",
    scope: "global",
    allowInInput: true,
    hideHint: true,
    // The palette owns Ctrl+J for list navigation.
    enabled: () => !uiStore.commandPaletteOpen,
    match: (e, meta) => meta && e.key === "j",
    run: () => {
      if (agentStore.panelOpen) agentStore.closePanel();
      else void agentStore.openPanel();
    },
  },
  {
    id: "settings",
    keys: "⌘,",
    label: "Settings",
    scope: "global",
    allowInInput: true,
    hideHint: true,
    match: (e, meta) => meta && e.key === ",",
    run: () => uiStore.toggleSettings(),
  },
  {
    id: "toggle-sidebar",
    keys: "⌘B",
    label: "Toggle Sidebar",
    scope: "global",
    hideHint: true,
    match: (e, meta) => meta && e.key === "b",
    run: () => uiStore.toggleSidebar(),
  },
  {
    id: "escape",
    keys: "Esc",
    label: "Back",
    scope: "global",
    allowInInput: true,
    match: (e) => e.key === "Escape",
    run: (e) => runEscape(e.target, isInputElement(e.target)),
  },

  // --- Table view -----------------------------------------------------------
  {
    id: "table-navigate",
    keys: "j/k",
    label: "Navigate",
    scope: "table",
    handledElsewhere: true,
    match: (e) => e.key === "j" || e.key === "k",
    run: () => {},
  },
  {
    id: "table-open",
    keys: "⏎",
    label: "Open",
    scope: "table",
    handledElsewhere: true,
    match: (e) => e.key === "Enter",
    run: () => {},
  },
  {
    id: "table-filter",
    keys: "/",
    label: "Filter",
    scope: "table",
    match: (e) => e.key === "/",
    run: () => document.getElementById("resource-filter")?.focus(),
  },
  {
    id: "table-refresh",
    keys: "r",
    label: "Refresh",
    scope: "table",
    match: (e) => e.key === "r",
    run: () => void k8sStore.refreshResources(),
  },

  // --- Detail view ----------------------------------------------------------
  {
    id: "detail-logs",
    keys: "l",
    label: "Logs",
    scope: "details",
    enabled: () => selectedKind() === "pod" || selectedKind() === "deployment",
    match: (e) => e.key === "l",
    run: () => uiStore.showLogs(),
  },
  {
    id: "detail-shell",
    keys: "t",
    label: "Shell",
    scope: "details",
    enabled: () => selectedKind() === "pod",
    match: (e) => e.key === "t",
    run: () => uiStore.showTerminal(),
  },
  {
    id: "detail-yaml",
    keys: "e",
    label: "Edit YAML",
    scope: "details",
    match: (e) => e.key === "e",
    run: () => uiStore.showYamlEditor(),
  },
  {
    id: "detail-scale",
    keys: "s",
    label: "Scale",
    scope: "details",
    enabled: () => SCALABLE_TYPES.includes(`${selectedKind()}s`),
    match: (e) => e.key === "s",
    run: () => {
      const resource = k8sStore.selectedResource;
      if (resource) dialogStore.openScale(resource);
    },
  },
  {
    id: "detail-delete",
    keys: "d",
    label: "Delete",
    scope: "details",
    match: (e) => e.key === "d",
    run: () => {
      const resource = k8sStore.selectedResource;
      if (resource) dialogStore.openDelete(resource);
    },
  },
];

/** True when the shortcut has no gate, or its gate currently passes. */
export function isActive(s: Shortcut): boolean {
  return !s.enabled || s.enabled();
}

/**
 * Shortcuts that apply to `view`, in the order they should be advertised:
 * view-specific first (they are what the user is about to use), then global.
 * Gated entries whose condition currently fails are dropped.
 */
export function shortcutsForView(view: ActiveView): Shortcut[] {
  const scope: ShortcutScope | null =
    view === "table" ? "table" : view === "details" ? "details" : null;
  return SHORTCUTS.filter(
    (s) => (s.scope === scope || s.scope === "global") && isActive(s),
  ).sort((a, b) => Number(a.scope === "global") - Number(b.scope === "global"));
}

/** The subset the status bar shows — the rest live in Settings only. */
export function hintsForView(view: ActiveView): Shortcut[] {
  return shortcutsForView(view).filter((s) => !s.hideHint);
}
