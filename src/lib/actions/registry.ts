import {
  FileText, Terminal, Scale, RotateCcw, History, Trash2,
  ClipboardCopy, GitFork, Pencil, Copy, FileJson,
  ExternalLink, Pin, PinOff, Ban, CircleCheck, Droplets, GitCompare, Bell, BellOff, PencilLine,
  Play, Pause, RefreshCw,
} from "lucide-svelte";
import type { ActionDef, BulkActionDef } from "./types";
import type { Resource } from "$lib/types";
import { k8sStore } from "$lib/stores/k8s.svelte";
import { uiStore } from "$lib/stores/ui.svelte";
import type { DetailSubtab } from "$lib/stores/ui.logic";
import { toastStore } from "$lib/stores/toast.svelte";
import { topologyStore } from "$lib/stores/topology.svelte";
import { settingsStore } from "$lib/stores/settings.svelte";
import { alertStore } from "$lib/stores/alerts.svelte";
import { QUICK_EDIT_TYPES } from "$lib/components/details/quick-edit.logic";
import { kindToResourceType } from "$lib/utils/related-resources";
import { dialogStore } from "$lib/stores/dialogs.svelte";
import { isCordoned, setNodeSchedulable } from "./node-ops";
import { extensions } from "$lib/extensions";
import { invoke } from "$lib/ipc/core";
import { open as shellOpen } from "$lib/ipc/shell";

export { SCALABLE_TYPES, RESTARTABLE_TYPES, ALERTABLE_TYPES, LOG_TYPES, GROUP_ORDER, groupActions, getResourceUrl } from "./registry.logic.js";
import { SCALABLE_TYPES, RESTARTABLE_TYPES, ALERTABLE_TYPES, LOG_TYPES, GROUP_ORDER, getResourceUrl as getResourceUrlPure } from "./registry.logic.js";

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

/**
 * Restart several workloads at once (the bulk action). One target reports
 * like a single restart; several report a summary. Errors are toasted here —
 * callers (the confirmation dialog) only await completion.
 */
export async function restartWorkloads(resources: Resource[]): Promise<void> {
  if (resources.length === 1) {
    try {
      await restartWorkload(resources[0]);
    } catch (err) {
      toastStore.error("Restart failed", String(err));
    }
    return;
  }
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

/** Create a Job from the CronJob's template right now (kubectl create job --from). */
export async function triggerCronJob(resource: Resource): Promise<void> {
  const created = await invoke<{ name: string; namespace: string }>("trigger_cronjob", {
    name: resource.metadata.name,
    namespace: resource.metadata.namespace ?? "",
  });
  toastStore.success("Job created", `Job "${created.name}" started from CronJob "${resource.metadata.name}"`);
  await k8sStore.refreshResources();
}

export function isCronJobSuspended(resource: Resource): boolean {
  return resource.spec?.suspend === true;
}

/** Pause (suspend=true) or resume (suspend=false) a CronJob's schedule. */
export async function setCronJobSuspend(resource: Resource, suspend: boolean): Promise<void> {
  await invoke("set_cronjob_suspend", {
    name: resource.metadata.name,
    namespace: resource.metadata.namespace ?? "",
    suspend,
  });
  toastStore.success(
    suspend ? "CronJob suspended" : "CronJob resumed",
    suspend
      ? `"${resource.metadata.name}" will not schedule new jobs until resumed`
      : `"${resource.metadata.name}" is scheduling jobs again`,
  );
  await k8sStore.refreshResources();
}

/** Create a fresh Job with the same spec as this one (typically a failed run). */
export async function rerunJob(resource: Resource): Promise<void> {
  const created = await invoke<{ name: string; namespace: string }>("rerun_job", {
    name: resource.metadata.name,
    namespace: resource.metadata.namespace ?? "",
  });
  toastStore.success("Job re-run", `Job "${created.name}" created from "${resource.metadata.name}"`);
  await k8sStore.refreshResources();
}

/**
 * Open the resource's detail tab on a given sub-tab. When that detail is
 * already the active tab, only the sub-tab changes (no duplicate tab).
 */
function openInDetail(resource: Resource, subtab: DetailSubtab): void {
  const alreadyOpen =
    uiStore.activeView === "details" &&
    k8sStore.selectedResource?.metadata.uid === resource.metadata.uid;
  if (!alreadyOpen) {
    uiStore.showDetails(resource.metadata.name, resource.kind, resource.metadata.namespace ?? undefined, resource);
    k8sStore.selectResource(resource);
  }
  uiStore.detailSubtab = subtab;
}

/**
 * Start a privileged host shell pod on the node and open its terminal. Shared
 * by the row action and the node detail header.
 */
export async function startNodeShell(resource: Resource): Promise<void> {
  const node = resource.metadata.name;
  const toastId = toastStore.info("Starting node shell", `Creating a host shell pod on "${node}"…`);
  try {
    const { name, namespace } = await invoke<{ name: string; namespace: string }>(
      "start_node_shell",
      { nodeName: node },
    );
    const pod = await invoke<Resource>("get_resource", {
      kind: "pod",
      name,
      namespace,
    });
    openInDetail(pod, "shell");
  } catch (err) {
    toastStore.error("Node shell failed", String(err));
  } finally {
    toastStore.dismiss(toastId);
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
      uiStore.showView("topology");
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
    // Through the DetailPanel (header, actions, tabs) — never the bare
    // top-level YAML tab.
    execute: (resource) => openInDetail(resource, "yaml"),
  },
  {
    id: "compare-namespaces",
    label: "Compare Across Namespaces / Contexts...",
    icon: GitCompare,
    tier: "green",
    group: "navigate",
    priority: 50,
    // Only namespaced resources have siblings to diff against.
    appliesTo: (_rt, resource) => !!resource?.metadata.namespace,
    execute: (resource) => dialogStore.openCompare(resource),
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
    id: "quick-edit",
    label: "Quick Edit...",
    icon: PencilLine,
    tier: "yellow",
    group: "operations",
    priority: 12,
    appliesTo: (rt) => QUICK_EDIT_TYPES.includes(rt),
    execute: (resource) => dialogStore.openQuickEdit(resource),
  },
  {
    id: "restart",
    label: "Restart",
    icon: RotateCcw,
    tier: "yellow",
    group: "operations",
    priority: 20,
    appliesTo: (rt) => RESTARTABLE_TYPES.includes(rt),
    execute: (resource) => dialogStore.openRestart(resource),
  },
  {
    id: "rollback",
    label: "Rollback",
    icon: History,
    tier: "yellow",
    group: "operations",
    priority: 30,
    appliesTo: (rt) => rt === "deployments",
    execute: (resource) => dialogStore.openRollback(resource),
  },
  {
    id: "trigger-cronjob",
    label: "Trigger Now",
    icon: Play,
    tier: "yellow",
    group: "operations",
    priority: 31,
    appliesTo: (rt) => rt === "cronjobs",
    execute: async (resource) => {
      try {
        await triggerCronJob(resource);
      } catch (err) {
        toastStore.error("Trigger failed", String(err));
      }
    },
  },
  {
    id: "suspend-cronjob",
    label: "Suspend",
    icon: Pause,
    tier: "yellow",
    group: "operations",
    priority: 31,
    appliesTo: (rt, resource) => rt === "cronjobs" && !(resource && isCronJobSuspended(resource)),
    execute: async (resource) => {
      try {
        await setCronJobSuspend(resource, true);
      } catch (err) {
        toastStore.error("Suspend failed", String(err));
      }
    },
  },
  {
    id: "resume-cronjob",
    label: "Resume",
    icon: Play,
    tier: "yellow",
    group: "operations",
    priority: 31,
    appliesTo: (rt, resource) => rt === "cronjobs" && !!resource && isCronJobSuspended(resource),
    execute: async (resource) => {
      try {
        await setCronJobSuspend(resource, false);
      } catch (err) {
        toastStore.error("Resume failed", String(err));
      }
    },
  },
  {
    id: "rerun-job",
    label: "Re-run",
    icon: RefreshCw,
    tier: "yellow",
    group: "operations",
    priority: 31,
    appliesTo: (rt) => rt === "jobs",
    execute: async (resource) => {
      try {
        await rerunJob(resource);
      } catch (err) {
        toastStore.error("Re-run failed", String(err));
      }
    },
  },

  // --- Operations group (continued) ---
  {
    id: "cordon-node",
    label: "Cordon",
    icon: Ban,
    tier: "yellow",
    group: "operations",
    priority: 32,
    appliesTo: (rt, resource) => rt === "nodes" && !(resource && isCordoned(resource)),
    execute: async (resource) => {
      try {
        await setNodeSchedulable(resource.metadata.name, false);
      } catch (err) {
        toastStore.error("Cordon failed", String(err));
      }
    },
  },
  {
    id: "uncordon-node",
    label: "Uncordon",
    icon: CircleCheck,
    tier: "yellow",
    group: "operations",
    priority: 32,
    appliesTo: (rt, resource) => rt === "nodes" && !!resource && isCordoned(resource),
    execute: async (resource) => {
      try {
        await setNodeSchedulable(resource.metadata.name, true);
      } catch (err) {
        toastStore.error("Uncordon failed", String(err));
      }
    },
  },
  {
    id: "node-shell",
    label: "Node Shell",
    icon: Terminal,
    tier: "yellow",
    group: "operations",
    priority: 33,
    appliesTo: (rt) => rt === "nodes",
    execute: (resource) => startNodeShell(resource),
  },
  {
    id: "drain-node",
    label: "Drain...",
    icon: Droplets,
    tier: "red",
    group: "operations",
    priority: 34,
    appliesTo: (rt) => rt === "nodes",
    execute: (resource) => dialogStore.openDrain(resource.metadata.name),
  },
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
    id: "watch-alerts",
    label: "Watch for Alerts",
    icon: Bell,
    tier: "green",
    group: "operations",
    priority: 58,
    appliesTo: (rt, resource) => ALERTABLE_TYPES.includes(rt) && (!resource || !alertStore.isWatched(resource)),
    execute: (resource) => alertStore.watch(resource),
  },
  {
    id: "unwatch-alerts",
    label: "Stop Watching",
    icon: BellOff,
    tier: "green",
    group: "operations",
    priority: 58,
    appliesTo: (rt, resource) => ALERTABLE_TYPES.includes(rt) && !!resource && alertStore.isWatched(resource),
    execute: (resource) => {
      alertStore.unwatch(resource);
      toastStore.info("Stopped watching", `${resource.metadata.name} no longer raises alerts`);
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
    execute: (resources) => dialogStore.openRestart(resources),
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
