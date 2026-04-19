// Extension registry types.
// The core app is complete without any extensions. Optional capabilities
// (additional UI, actions, commands, settings tabs, lifecycle listeners)
// register into this registry at startup. Core code reads the registry and
// renders whatever is registered; if nothing is registered, core renders
// the base experience unchanged.

import type { Component } from "svelte";
import type { Resource } from "$lib/types";
import type { ActionDef } from "$lib/actions/types";

// ---------------------------------------------------------------------------
// Slot mounts (UI extension points)
// ---------------------------------------------------------------------------

/**
 * Prop shape expected by each named slot. Extend this map when adding a new
 * slot. Keeping a single source of truth lets TypeScript enforce that the
 * component a caller registers matches the props the slot will feed it.
 */
export interface SlotProps {
  "app-overlay": Record<string, never>;
  "app-top-banner": Record<string, never>;
  "sidebar-header": Record<string, never>;
  "sidebar-footer": Record<string, never>;
  "cluster-rail-top": Record<string, never>;
  "cluster-rail-bottom": Record<string, never>;
  "status-bar-start": Record<string, never>;
  "status-bar-end": Record<string, never>;
  "table-header-trailing": Record<string, never>;
  "table-row-leading": { resource: Resource };
  "table-row-trailing": { resource: Resource };
  "detail-panel-actions": { resource: Resource };
  "detail-panel-tabs": { resource: Resource };
}

export type SlotName = keyof SlotProps;

export interface SlotMount<S extends SlotName = SlotName> {
  id: string;
  slot: S;
  component: Component<SlotProps[S]>;
  /**
   * Optional reactive visibility predicate. When defined and it returns
   * false, core consumers skip rendering this mount. Accessing reactive
   * state inside the function is fine — Svelte tracks the read through the
   * call.
   */
  visible?: () => boolean;
  order?: number;
}

// ---------------------------------------------------------------------------
// Resource actions (row menus, detail panel actions)
//
// The canonical action type lives in $lib/actions/types — re-exported here
// so extension producers import everything from $lib/extensions.
// ---------------------------------------------------------------------------

export type { ActionDef } from "$lib/actions/types";

// ---------------------------------------------------------------------------
// Command palette
//
// The canonical item type lives in $lib/types/ui — re-exported here so
// extension producers import everything from $lib/extensions.
// ---------------------------------------------------------------------------

export type { CommandPaletteItem as PaletteCommand } from "$lib/types/ui";

// ---------------------------------------------------------------------------
// Settings tabs
// ---------------------------------------------------------------------------

export interface SettingsTab {
  id: string;
  label: string;
  // Icon is typed loosely to accommodate lucide-svelte icons whose runtime
  // shape does not line up perfectly with Svelte 5's `Component` signature.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon?: any;
  component: Component;
  order?: number;
}

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

export type AppEvent =
  | { type: "context-changed"; contextName: string }
  | { type: "namespace-changed"; namespace: string }
  | { type: "resource-selected"; resource: Resource | null };

export type AppEventType = AppEvent["type"];

export type EventHandler<T extends AppEventType> = (
  event: Extract<AppEvent, { type: T }>,
) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Keyboard hints (status bar)
// ---------------------------------------------------------------------------

export interface KbdHint {
  id: string;
  key: string;
  label: string;
  order?: number;
}

// ---------------------------------------------------------------------------
// Startup hooks
// ---------------------------------------------------------------------------

export type StartupHook = () => void | Promise<void>;
