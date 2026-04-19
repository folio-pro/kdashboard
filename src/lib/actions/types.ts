import type { Resource } from "$lib/types";

/**
 * A Svelte component used as an icon. lucide-svelte exports class-based
 * (legacy) components and this type must accept both those and native Svelte 5
 * function components without forcing generic ceremony at each call site.
 *
 * Tried (and discarded): Component<Record<string, unknown>> from "svelte" —
 * re-introduces 36 svelte-check errors because lucide-svelte's typeof FooIcon
 * is a class (SvelteComponentTyped) and Svelte 5's Component<P> is a function
 * signature. The two are not assignable. Keep `any` with the eslint override
 * until lucide-svelte ships Svelte 5 function components.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IconComponent = any;

export type ActionTier = "green" | "yellow" | "red";

export type ActionGroup =
  | "smart"        // State-aware actions (top of menu)
  | "navigate"     // View logs, terminal, topology
  | "operations"   // Scale, restart, rollback
  | "clipboard"    // Copy name, YAML, JSON
  | "destructive"; // Delete

export interface ActionDef {
  id: string;
  label: string;
  icon?: IconComponent;
  shortcut?: string;
  tier: ActionTier;
  group: ActionGroup;
  /** Lower = higher in menu within group */
  priority: number;
  /** Does this action apply to this resource type? */
  appliesTo: (resourceType: string, resource?: Resource) => boolean;
  /** Is the action currently enabled? (greyed out if false) */
  enabled?: (resource: Resource) => boolean;
  /** Tooltip when disabled */
  disabledReason?: (resource: Resource) => string;
  /** Execute the action */
  execute: (resource: Resource) => void;
}

export interface BulkActionDef {
  id: string;
  label: string;
  icon?: IconComponent;
  tier: ActionTier;
  group: ActionGroup;
  priority: number;
  appliesTo: (resourceType: string) => boolean;
  execute: (resources: Resource[]) => void;
}

export interface TableAction {
  id: string;
  label: string;
  icon?: IconComponent;
  execute: () => void;
}

export interface MenuContext {
  type: "resource" | "bulk" | "table";
  resource?: Resource;
  resourceType?: string;
  resources?: Resource[];
  tableActions?: TableAction[];
}
