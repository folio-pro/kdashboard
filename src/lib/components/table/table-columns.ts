import type { Column } from "$lib/types";
import { clampColumnWidth } from "./resource-table";

// ---------------------------------------------------------------------------
// Column definitions for each Kubernetes resource type
// ---------------------------------------------------------------------------

export const columnsByType: Record<string, Column[]> = {
  pods: [
    { key: "name", label: "Name", sortable: true },
    { key: "containers", label: "Containers", sortable: false, width: "120px" },
    { key: "namespace", label: "Namespace", sortable: true, width: "150px" },
    { key: "status", label: "Status", sortable: true, width: "120px" },
    { key: "restarts", label: "Restarts", sortable: true, width: "90px" },
    { key: "age", label: "Age", sortable: true, width: "70px" },
    { key: "node", label: "Node", sortable: true },
  ],
  deployments: [
    { key: "name", label: "Name", sortable: true },
    { key: "namespace", label: "Namespace", sortable: true, width: "150px" },
    { key: "deployReady", label: "Ready", sortable: false, width: "80px" },
    { key: "upToDate", label: "Up-to-date", sortable: false, width: "90px" },
    { key: "available", label: "Available", sortable: false, width: "90px" },
    { key: "age", label: "Age", sortable: true, width: "80px" },
  ],
  services: [
    { key: "name", label: "Name", sortable: true },
    { key: "namespace", label: "Namespace", sortable: true, width: "150px" },
    { key: "type", label: "Type", sortable: true, width: "100px" },
    { key: "clusterIP", label: "Cluster IP", sortable: false, width: "130px" },
    { key: "externalIP", label: "External IP", sortable: false, width: "130px" },
    { key: "ports", label: "Ports", sortable: false },
    { key: "age", label: "Age", sortable: true, width: "80px" },
  ],
  replicasets: [
    { key: "name", label: "Name", sortable: true },
    { key: "namespace", label: "Namespace", sortable: true, width: "150px" },
    { key: "rsDesired", label: "Desired", sortable: false, width: "80px" },
    { key: "rsCurrent", label: "Current", sortable: false, width: "80px" },
    { key: "rsReady", label: "Ready", sortable: false, width: "80px" },
    { key: "age", label: "Age", sortable: true, width: "80px" },
  ],
  statefulsets: [
    { key: "name", label: "Name", sortable: true },
    { key: "namespace", label: "Namespace", sortable: true, width: "150px" },
    { key: "stsReady", label: "Ready", sortable: false, width: "80px" },
    { key: "age", label: "Age", sortable: true, width: "80px" },
  ],
  daemonsets: [
    { key: "name", label: "Name", sortable: true },
    { key: "namespace", label: "Namespace", sortable: true, width: "150px" },
    { key: "dsDesired", label: "Desired", sortable: false, width: "80px" },
    { key: "dsCurrent", label: "Current", sortable: false, width: "80px" },
    { key: "dsReady", label: "Ready", sortable: false, width: "80px" },
    { key: "dsAvailable", label: "Available", sortable: false, width: "90px" },
    { key: "age", label: "Age", sortable: true, width: "80px" },
  ],
  jobs: [
    { key: "name", label: "Name", sortable: true },
    { key: "namespace", label: "Namespace", sortable: true, width: "150px" },
    { key: "jobCompletions", label: "Completions", sortable: false, width: "110px" },
    { key: "jobDuration", label: "Duration", sortable: false, width: "100px" },
    { key: "age", label: "Age", sortable: true, width: "80px" },
  ],
  cronjobs: [
    { key: "name", label: "Name", sortable: true },
    { key: "namespace", label: "Namespace", sortable: true, width: "150px" },
    { key: "cjSchedule", label: "Schedule", sortable: false, width: "120px" },
    { key: "cjSuspend", label: "Suspend", sortable: false, width: "80px" },
    { key: "cjActive", label: "Active", sortable: false, width: "70px" },
    { key: "cjLastSchedule", label: "Last Schedule", sortable: false, width: "110px" },
    { key: "age", label: "Age", sortable: true, width: "80px" },
  ],
  ingresses: [
    { key: "name", label: "Name", sortable: true },
    { key: "namespace", label: "Namespace", sortable: true, width: "150px" },
    { key: "ingressClass", label: "Class", sortable: true, width: "120px" },
    { key: "ingressHosts", label: "Hosts", sortable: false },
    { key: "ingressAddress", label: "Address", sortable: false, width: "130px" },
    { key: "age", label: "Age", sortable: true, width: "80px" },
  ],
  configmaps: [
    { key: "name", label: "Name", sortable: true },
    { key: "namespace", label: "Namespace", sortable: true, width: "150px" },
    { key: "data", label: "Data", sortable: true, width: "80px" },
    { key: "age", label: "Age", sortable: true, width: "80px" },
  ],
  secrets: [
    { key: "name", label: "Name", sortable: true },
    { key: "namespace", label: "Namespace", sortable: true, width: "150px" },
    { key: "type", label: "Type", sortable: true, width: "200px" },
    { key: "data", label: "Data", sortable: true, width: "80px" },
    { key: "age", label: "Age", sortable: true, width: "80px" },
  ],
  hpa: [
    { key: "name", label: "Name", sortable: true },
    { key: "namespace", label: "Namespace", sortable: true, width: "150px" },
    { key: "hpaReference", label: "Reference", sortable: false },
    { key: "hpaMinPods", label: "Min Pods", sortable: false, width: "90px" },
    { key: "hpaMaxPods", label: "Max Pods", sortable: false, width: "90px" },
    { key: "hpaCurrentReplicas", label: "Current Replicas", sortable: false, width: "130px" },
    { key: "age", label: "Age", sortable: true, width: "80px" },
  ],
  vpa: [
    { key: "name", label: "Name", sortable: true },
    { key: "namespace", label: "Namespace", sortable: true, width: "150px" },
    { key: "vpaTarget", label: "Target", sortable: false },
    { key: "vpaUpdateMode", label: "Update Mode", sortable: false, width: "120px" },
    { key: "age", label: "Age", sortable: true, width: "80px" },
  ],
  nodes: [
    { key: "name", label: "Name", sortable: true },
    { key: "status", label: "Status", sortable: true, width: "100px" },
    { key: "roles", label: "Roles", sortable: false },
    { key: "cpuUsage", label: "CPU", sortable: false, width: "130px" },
    { key: "memUsage", label: "Memory", sortable: false, width: "130px" },
    { key: "instanceType", label: "Instance", sortable: false, width: "140px" },
    { key: "nodeCost", label: "$/mo", sortable: false, width: "90px" },
    { key: "version", label: "Version", sortable: false, width: "120px" },
    { key: "age", label: "Age", sortable: true, width: "80px" },
  ],
  namespaces: [
    { key: "name", label: "Name", sortable: true },
    { key: "status", label: "Status", sortable: true, width: "100px" },
    { key: "age", label: "Age", sortable: true, width: "80px" },
  ],
  persistentvolumes: [
    { key: "name", label: "Name", sortable: true },
    { key: "status", label: "Status", sortable: true, width: "100px" },
    { key: "age", label: "Age", sortable: true, width: "80px" },
  ],
  persistentvolumeclaims: [
    { key: "name", label: "Name", sortable: true },
    { key: "namespace", label: "Namespace", sortable: true, width: "150px" },
    { key: "status", label: "Status", sortable: true, width: "100px" },
    { key: "age", label: "Age", sortable: true, width: "80px" },
  ],
  storageclasses: [
    { key: "name", label: "Name", sortable: true },
    { key: "age", label: "Age", sortable: true, width: "80px" },
  ],
  clusterroles: [
    { key: "name", label: "Name", sortable: true },
    { key: "age", label: "Age", sortable: true, width: "80px" },
  ],
  clusterrolebindings: [
    { key: "name", label: "Name", sortable: true },
    { key: "age", label: "Age", sortable: true, width: "80px" },
  ],
};

export const defaultColumns: Column[] = [
  { key: "name", label: "Name", sortable: true },
  { key: "namespace", label: "Namespace", sortable: true, width: "150px" },
  { key: "age", label: "Age", sortable: true, width: "80px" },
];

// ---------------------------------------------------------------------------
// Per-resource-type column width overrides (runtime state — not persisted)
// ---------------------------------------------------------------------------

/** Get a user-resized column width for the current resource type, if any. */
export function getColumnWidth(
  overrides: Record<string, Record<string, number>>,
  resourceType: string,
  colKey: string,
): number | undefined {
  return overrides[resourceType]?.[colKey];
}

/** Set a user-resized column width for the current resource type. */
export function setColumnWidth(
  overrides: Record<string, Record<string, number>>,
  resourceType: string,
  colKey: string,
  width: number,
): void {
  if (!overrides[resourceType]) overrides[resourceType] = {};
  overrides[resourceType][colKey] = clampColumnWidth(width);
}
