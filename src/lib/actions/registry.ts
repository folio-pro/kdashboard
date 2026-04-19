import {
  FileText, Terminal, Scale, RotateCcw, History, Trash2,
  ClipboardCopy, GitFork, Pencil, Copy, FileJson,
  ExternalLink, Pin, PinOff,
} from "lucide-svelte";
import type { ActionDef, BulkActionDef } from "./types";
import type { Resource } from "$lib/types";
import { k8sStore } from "$lib/stores/k8s.svelte";
import { uiStore } from "$lib/stores/ui.svelte";
import { toastStore } from "$lib/stores/toast.svelte";
import { topologyStore } from "$lib/stores/topology.svelte";
import { settingsStore } from "$lib/stores/settings.svelte";
import { kindToResourceType } from "$lib/utils/related-resources";
import { dialogStore } from "$lib/stores/dialogs.svelte";
import { extensions } from "$lib/extensions";
import { invoke } from "@tauri-apps/api/core";
import { open as shellOpen } from "@tauri-apps/plugin-shell";

export { SCALABLE_TYPES, RESTARTABLE_TYPES, LOG_TYPES, GROUP_ORDER, groupActions, getResourceUrl } from "./registry.logic.js";
import { SCALABLE_TYPES, RESTARTABLE_TYPES, LOG_TYPES, GROUP_ORDER, getResourceUrl as getResourceUrlPure } from "./registry.logic.js";

// --- Shared operation functions (used by both registry and DetailPanel) ---

export async function restartWorkload(resource: Resource): Promise<void> {
  await invoke("restart_workload", {
    kind: resource.kind,
    name: resource.metadata.name,
    namespace: resource.metadata.namespace ?? "",
  });
  toastStore.success(
    "Restart initiated",
    `${resource.kind} "${resource.metadata.name}" is restarting`,
  );
  await k8sStore.refreshResources();
}

export async function rollbackDeployment(
  resource: Resource,
  revision?: number,
): Promise<void> {
  const msg = await invoke<string>("rollback_deployment", {
    name: resource.metadata.name,
    namespace: resource.metadata.namespace ?? "",
    revision: revision ?? null,
  });
  toastStore.success("Rollback successful", msg);
  await k8sStore.refreshResources();
}

/** Callers that opened a confirmation dialog should close it BEFORE calling. */
export async function deleteResource(resource: Resource): Promise<void> {
  try {
    await invoke("delete_resource", {
      kind: resource.kind,
      name: resource.metadata.name,
      namespace: resource.metadata.namespace ?? "",
      uid: resource.metadata.uid,
      resource_version: resource.metadata.resource_version,
    });
    toastStore.success(
      "Resource deleted",
      `${resource.kind} "${resource.metadata.name}" deleted`,
    );
    if (k8sStore.selectedResource?.metadata.uid === resource.metadata.uid) {
      k8sStore.selectResource(null);
    }
    await k8sStore.refreshResources();
  } catch (err) {
    toastStore.error("Delete failed", String(err));
  }
}

/** Wrapper that passes live port-forwards from the k8s store */
function getResourceUrlWithPf(resource: Resource): string | null {
  return getResourceUrlPure(resource, k8sStore.portForwards as any);
}

// --- Action definitions (already in group+priority order) ---

/** All single-resource actions available in the app */
export const resourceActions: ActionDef[] = [
  // --- Navigate group ---
  {
    id: "view-logs",
    label: "View Logs",
    icon: FileText,
    shortcut: "\u2318L",
    tier: "green",
    group: "navigate",
    priority: 10,
    appliesTo: (rt) => LOG_TYPES.includes(rt),
    execute: () => uiStore.showLogs(),
  },
  {
    id: "open-terminal",
    label: "Open Terminal",
    icon: Terminal,
    shortcut: "\u2318T",
    tier: "green",
    group: "navigate",
    priority: 20,
    appliesTo: (rt) => rt === "pods",
    execute: () => uiStore.showTerminal(),
  },
  {
    id: "show-topology",
    label: "View Topology",
    icon: GitFork,
    tier: "green",
    group: "navigate",
    priority: 30,
    appliesTo: () => true,
    execute: (resource) => {
      topologyStore.loadResourceTopology(
        resource.metadata.uid,
        resource.metadata.namespace ?? null,
      );
      uiStore.showTopology();
    },
  },
  {
    id: "edit-yaml",
    label: "Edit YAML",
    icon: Pencil,
    shortcut: "E",
    tier: "green",
    group: "navigate",
    priority: 40,
    appliesTo: () => true,
    execute: () => uiStore.showYamlEditor(),
  },
  // --- Operations group ---
  {
    id: "scale",
    label: "Scale Replicas...",
    icon: Scale,
    shortcut: "S",
    tier: "yellow",
    group: "operations",
    priority: 10,
    appliesTo: (rt) => SCALABLE_TYPES.includes(rt),
    execute: (resource) => dialogStore.openScale(resource),
  },
  {
    id: "restart",
    label: "Restart",
    icon: RotateCcw,
    tier: "yellow",
    group: "operations",
    priority: 20,
    appliesTo: (rt) => RESTARTABLE_TYPES.includes(rt),
    execute: async (resource) => {
      try {
        await restartWorkload(resource);
      } catch (err) {
        toastStore.error("Restart failed", String(err));
      }
    },
  },
  {
    id: "rollback",
    label: "Rollback",
    icon: History,
    tier: "yellow",
    group: "operations",
    priority: 30,
    appliesTo: (rt) => rt === "deployments",
    execute: async (resource) => {
      try {
        await rollbackDeployment(resource);
      } catch (err) {
        toastStore.error("Rollback failed", String(err));
      }
    },
  },

  // --- Operations group (continued) ---
  {
    id: "open-in-browser",
    label: "Open in Browser",
    icon: ExternalLink,
    tier: "green",
    group: "operations",
    priority: 40,
    appliesTo: (rt) => rt === "services" || rt === "ingresses",
    enabled: (resource) => !!getResourceUrlWithPf(resource),
    disabledReason: () => "No external IP or hostname available",
    execute: (resource) => {
      const url = getResourceUrlWithPf(resource);
      if (url) {
        shellOpen(url).catch(() => {
          toastStore.error("Failed to open browser", url);
        });
      }
    },
  },
  {
    id: "pin-resource",
    label: "Pin to Sidebar",
    icon: Pin,
    tier: "green",
    group: "operations",
    priority: 60,
    appliesTo: (_, resource) => {
      if (!resource) return true;
      return !settingsStore.isPinned(resource.kind, resource.metadata.name, resource.metadata.namespace);
    },
    execute: (resource) => {
      settingsStore.pinResource({
        kind: resource.kind,
        name: resource.metadata.name,
        namespace: resource.metadata.namespace,
        resourceType: kindToResourceType(resource.kind),
      });
      toastStore.success("Pinned", `${resource.metadata.name} pinned to sidebar`);
    },
  },
  {
    id: "unpin-resource",
    label: "Unpin from Sidebar",
    icon: PinOff,
    tier: "green",
    group: "operations",
    priority: 60,
    appliesTo: (_, resource) => {
      if (!resource) return false;
      return settingsStore.isPinned(resource.kind, resource.metadata.name, resource.metadata.namespace);
    },
    execute: (resource) => {
      settingsStore.unpinResource(resource.kind, resource.metadata.name, resource.metadata.namespace);
      toastStore.success("Unpinned", `${resource.metadata.name} removed from sidebar`);
    },
  },

  // --- Clipboard group ---
  {
    id: "copy-name",
    label: "Copy Name",
    icon: ClipboardCopy,
    tier: "green",
    group: "clipboard",
    priority: 10,
    appliesTo: () => true,
    execute: async (resource) => {
      await navigator.clipboard.writeText(resource.metadata.name);
      toastStore.success("Copied", `"${resource.metadata.name}" copied to clipboard`);
    },
  },
  {
    id: "copy-namespace",
    label: "Copy Namespace",
    icon: Copy,
    tier: "green",
    group: "clipboard",
    priority: 20,
    appliesTo: (_, resource) => !!resource?.metadata.namespace,
    execute: async (resource) => {
      const ns = resource.metadata.namespace ?? "";
      await navigator.clipboard.writeText(ns);
      toastStore.success("Copied", `"${ns}" copied to clipboard`);
    },
  },
  {
    id: "copy-yaml",
    label: "Copy as YAML",
    icon: FileText,
    tier: "green",
    group: "clipboard",
    priority: 30,
    appliesTo: () => true,
    execute: async (resource) => {
      try {
        const yaml = await invoke<string>("get_resource_yaml", {
          kind: resource.kind,
          name: resource.metadata.name,
          namespace: resource.metadata.namespace ?? "",
        });
        await navigator.clipboard.writeText(yaml);
        toastStore.success("Copied", "YAML copied to clipboard");
      } catch (err) {
        toastStore.error("Copy failed", String(err));
      }
    },
  },
  {
    id: "copy-json",
    label: "Copy as JSON",
    icon: FileJson,
    tier: "green",
    group: "clipboard",
    priority: 40,
    appliesTo: () => true,
    execute: async (resource) => {
      await navigator.clipboard.writeText(JSON.stringify(resource, null, 2));
      toastStore.success("Copied", "JSON copied to clipboard");
    },
  },

  // --- Destructive group ---
  {
    id: "delete",
    label: "Delete",
    icon: Trash2,
    shortcut: "\u232B",
    tier: "red",
    group: "destructive",
    priority: 100,
    appliesTo: () => true,
    execute: (resource) => dialogStore.openDelete(resource),
  },
];

/** Bulk actions for multi-select */
export const bulkActions: BulkActionDef[] = [
  {
    id: "bulk-restart",
    label: "Restart",
    icon: RotateCcw,
    tier: "yellow",
    group: "operations",
    priority: 20,
    appliesTo: (rt) => RESTARTABLE_TYPES.includes(rt),
    execute: async (resources) => {
      const results = await Promise.allSettled(
        resources.map((r) =>
          invoke("restart_workload", {
            kind: r.kind,
            name: r.metadata.name,
            namespace: r.metadata.namespace ?? "",
          }),
        ),
      );
      const failCount = results.filter((r) => r.status === "rejected").length;
      if (failCount === 0) {
        toastStore.success("Restarted", `${resources.length} resources restarting`);
      } else {
        toastStore.error("Partial failure", `${failCount} of ${resources.length} restarts failed`);
      }
      await k8sStore.refreshResources();
    },
  },
  {
    id: "bulk-copy-names",
    label: "Copy Names",
    icon: ClipboardCopy,
    tier: "green",
    group: "clipboard",
    priority: 10,
    appliesTo: () => true,
    execute: async (resources) => {
      const names = resources.map((r) => r.metadata.name).join("\n");
      await navigator.clipboard.writeText(names);
      toastStore.success("Copied", `${resources.length} names copied to clipboard`);
    },
  },
  {
    id: "bulk-delete",
    label: "Delete",
    icon: Trash2,
    tier: "red",
    group: "destructive",
    priority: 100,
    appliesTo: () => true,
    execute: () => window.dispatchEvent(new CustomEvent("kdash:bulk-delete")),
  },
];

/** Get filtered actions for a specific resource (already sorted by group+priority) */
export function getActionsForResource(resource: Resource): ActionDef[] {
  const rt = kindToResourceType(resource.kind);
  const all = [...resourceActions, ...extensions.actions];
  return all.filter((a) => a.appliesTo(rt, resource));
}

/** Get bulk actions for a resource type (already sorted by group+priority) */
export function getBulkActions(resourceType: string): BulkActionDef[] {
  return bulkActions.filter((a) => a.appliesTo(resourceType));
}
