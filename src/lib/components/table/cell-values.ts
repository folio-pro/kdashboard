// Cell content for the resource table: one place that turns a Resource + a
// column key into what the row should show.
//
// This lived inside TableRow.svelte, where a ~180-line switch sat next to the
// rendering markup and grew a new arm per resource type. Keeping it here means
// the component only decides HOW to paint a cell, and every accessor is a plain
// function that can be unit-tested without mounting anything.

import type { NodeCostInfo, NodeMetricsInfo, PodUsageInfo, Resource } from "$lib/types";
import { formatAge } from "$lib/utils/age";
import { cpuCell, memoryCell, formatCpu, formatBytes } from "$lib/stores/metrics.logic";

/**
 * Everything a cell needs that does not live on the Resource itself. The row
 * component gathers it from the stores; keeping it a parameter is what lets
 * this module stay pure (and testable under bun, which cannot run runes).
 */
export interface CellContext {
  /** Bumped every 30s so age cells re-render; read, never displayed. */
  ageTick: number;
  /** Cloud pricing for this node, when the row is a Node. */
  nodeCost?: NodeCostInfo;
  /** metrics-server capacity/usage for this node, when the row is a Node. */
  nodeMetrics?: NodeMetricsInfo;
  /** metrics-server usage for this pod, when the row is a Pod. */
  podUsage?: PodUsageInfo;
}

/** Placeholder for "this resource has no such value". */
const NONE = "-";

type Json = Record<string, unknown>;

/** Join a list into a cell, collapsing the tail into "+N" past `max`. */
function summarize(values: string[], max: number, empty = NONE): string {
  if (values.length === 0) return empty;
  if (values.length <= max) return values.join(", ");
  return `${values.slice(0, max).join(", ")} +${values.length - max}`;
}

/** `Kind/name` for an object reference, or just the name when kindless. */
function refLabel(ref: { kind?: string; name?: string } | undefined): string {
  if (!ref?.name) return NONE;
  return ref.kind ? `${ref.kind}/${ref.name}` : ref.name;
}

function str(value: unknown): string {
  return typeof value === "string" && value !== "" ? value : NONE;
}

function bool(value: unknown): string {
  return value === undefined ? NONE : String(value === true);
}

function count(value: unknown): string {
  return (Array.isArray(value) ? value.length : 0).toString();
}

/**
 * When an Event was last observed: lastTimestamp for classic events, then the
 * series / eventTime fields the events.k8s.io shapes use, then firstTimestamp.
 * Null when the object carries none of them (caller falls back to creation).
 */
export function eventLastTimestamp(resource: Resource): string | null {
  const spec = (resource.spec ?? {}) as Json;
  const series = spec.series as { lastObservedTime?: string } | undefined;
  const candidate =
    spec.lastTimestamp ?? series?.lastObservedTime ?? spec.eventTime ?? spec.firstTimestamp;
  return typeof candidate === "string" && candidate !== "" ? candidate : null;
}

/**
 * The value shown in `key`'s cell. Unknown keys render as "-", which is what
 * lets a resource type ship a column before its accessor exists.
 */
export function getCellValue(resource: Resource, key: string, ctx: CellContext): string {
  const meta = resource.metadata;
  const status = (resource.status ?? {}) as Json;
  const spec = (resource.spec ?? {}) as Json;

  switch (key) {
    // --- Shared across every kind -----------------------------------------
    case "name":
      return meta.name;
    case "namespace":
      return meta.namespace ?? NONE;
    case "age":
      // Reading ageTick is what re-runs this every 30s so ages stay live.
      void ctx.ageTick;
      return formatAge(meta.creation_timestamp);
    case "status":
    case "phase":
      return str(status.phase ?? status.status);
    case "data": {
      const data = resource.data ?? spec.data ?? status.data;
      return data && typeof data === "object" ? Object.keys(data).length.toString() : "0";
    }

    // --- Pods --------------------------------------------------------------
    case "ready": {
      const statuses = status.containerStatuses as Array<{ ready: boolean }> | undefined;
      if (!statuses) return NONE;
      return `${statuses.filter((c) => c.ready).length}/${statuses.length}`;
    }
    case "restarts": {
      const statuses = status.containerStatuses as Array<{ restartCount: number }> | undefined;
      if (!statuses) return "0";
      return statuses.reduce((sum, c) => sum + (c.restartCount ?? 0), 0).toString();
    }
    case "node":
      return str(spec.nodeName ?? status.nodeName);
    case "ip":
      return str(status.podIP);

    // --- Workloads ---------------------------------------------------------
    case "deployReady":
      return `${(status.readyReplicas as number) ?? 0}/${(spec.replicas as number) ?? 0}`;
    case "upToDate":
      return ((status.updatedReplicas as number) ?? 0).toString();
    case "available":
      return ((status.availableReplicas as number) ?? 0).toString();

    // --- Services / networking ---------------------------------------------
    case "type":
      return str(spec.type);
    case "clusterIP":
      return str(spec.clusterIP);
    case "externalIP": {
      const lb = status.loadBalancer as { ingress?: Array<{ ip: string }> } | undefined;
      if (lb?.ingress?.length) return lb.ingress.map((e) => e.ip).join(", ");
      return (spec.externalIPs as string[])?.join(", ") ?? NONE;
    }
    case "ports": {
      const ports = spec.ports as Array<{ port: number; protocol?: string }> | undefined;
      if (!ports) return NONE;
      return ports.map((p) => `${p.port}/${p.protocol ?? "TCP"}`).join(", ");
    }
    case "endpointAddresses": {
      // Endpoints keeps addresses under subsets[]; show the first few with the
      // subset's port, since "10.0.0.1:8080" is what an operator looks for.
      const subsets = spec.subsets as
        | Array<{ addresses?: Array<{ ip?: string }>; ports?: Array<{ port?: number }> }>
        | undefined;
      const port = subsets?.[0]?.ports?.[0]?.port;
      const ips = (subsets ?? []).flatMap((s) =>
        (s.addresses ?? []).map((a) => a.ip).filter((ip): ip is string => Boolean(ip)),
      );
      return summarize(
        ips.map((ip) => (port ? `${ip}:${port}` : ip)),
        3,
        "<none>",
      );
    }
    case "addressType":
      return str(spec.addressType);
    case "sliceEndpoints": {
      const endpoints = spec.endpoints as Array<{ addresses?: string[] }> | undefined;
      return summarize((endpoints ?? []).flatMap((e) => e.addresses ?? []), 3, "<none>");
    }
    case "slicePorts": {
      const ports = spec.ports as Array<{ port?: number; protocol?: string }> | undefined;
      if (!ports?.length) return NONE;
      return ports.map((p) => `${p.port ?? "*"}/${p.protocol ?? "TCP"}`).join(", ");
    }
    case "ingressController":
      return str(spec.controller);

    // --- Nodes -------------------------------------------------------------
    case "roles": {
      const prefix = "node-role.kubernetes.io/";
      const roles = Object.keys(meta.labels ?? {})
        .filter((l) => l.startsWith(prefix))
        .map((l) => l.slice(prefix.length));
      return summarize(roles, 3);
    }
    case "version":
      return str((status.nodeInfo as Json | undefined)?.kubeletVersion);
    case "instanceType":
      return ctx.nodeCost?.instance_type ?? str(meta.labels?.["node.kubernetes.io/instance-type"]);
    case "nodeCost": {
      const price = ctx.nodeCost?.price_per_month ?? 0;
      return price > 0 ? `$${price.toFixed(2)}` : NONE;
    }

    // --- Autoscalers -------------------------------------------------------
    case "vpaTarget":
      // VPA uses spec.targetRef; WPA (Datadog) uses spec.scaleTargetRef.
      return refLabel((spec.targetRef ?? spec.scaleTargetRef) as { kind?: string; name?: string });
    case "vpaUpdateMode":
      return str((spec.updatePolicy as { updateMode?: string } | undefined)?.updateMode);

    // --- RBAC --------------------------------------------------------------
    case "bindingRole":
      return refLabel(spec.roleRef as { kind?: string; name?: string });
    case "bindingSubjects": {
      const subjects = spec.subjects as Array<{ kind?: string; name?: string }> | undefined;
      return summarize((subjects ?? []).map(refLabel), 3);
    }
    case "saSecrets":
      return count(spec.secrets);

    // --- Storage -----------------------------------------------------------
    case "scProvisioner":
      return str(spec.provisioner);
    case "scReclaimPolicy":
      return str(spec.reclaimPolicy);
    case "scBindingMode":
      return str(spec.volumeBindingMode);
    case "csiAttachRequired":
      return bool(spec.attachRequired);
    case "csiModes":
      return summarize((spec.volumeLifecycleModes as string[]) ?? [], 3);
    case "vaAttacher":
      return str(spec.attacher);
    case "vaVolume":
      return str((spec.source as { persistentVolumeName?: string } | undefined)?.persistentVolumeName);
    case "vaNode":
      return str(spec.nodeName);
    case "vaAttached":
      return bool(status.attached);

    // --- Events -------------------------------------------------------------
    // core/v1 Event fields ride in the synthetic spec (see kinds.ts `synth`).
    case "eventLastSeen": {
      void ctx.ageTick;
      return formatAge(eventLastTimestamp(resource) ?? meta.creation_timestamp);
    }
    case "eventType":
      return str(spec.type);
    case "eventReason":
      return str(spec.reason);
    case "eventObject":
      return refLabel(spec.involvedObject as { kind?: string; name?: string });
    case "eventMessage":
      return str(spec.message);
    case "eventCount": {
      const series = spec.series as { count?: number } | undefined;
      const n = (spec.count as number) ?? series?.count;
      return typeof n === "number" ? n.toString() : "1";
    }

    // --- Scheduling / policy -----------------------------------------------
    case "pcValue":
      return spec.value === undefined ? NONE : String(spec.value);
    case "pcGlobalDefault":
      return String(spec.globalDefault === true);
    case "rcHandler":
      return str(spec.handler);
    case "leaseHolder":
      return str(spec.holderIdentity);
    case "webhookCount":
      return count(spec.webhooks);
    case "webhookNames": {
      const webhooks = spec.webhooks as Array<{ name?: string }> | undefined;
      const names = (webhooks ?? [])
        .map((w) => w.name)
        .filter((n): n is string => Boolean(n));
      return summarize(names, 2);
    }

    default:
      return NONE;
  }
}

// ---------------------------------------------------------------------------
// Column families the row renders specially
// ---------------------------------------------------------------------------

/** Numeric / identifier cells, rendered in monospace tabular figures. */
const MONO_COLUMNS = new Set([
  "age", "ready", "deployReady", "upToDate", "available",
  "rsDesired", "rsCurrent", "rsReady", "stsReady",
  "dsDesired", "dsCurrent", "dsReady", "dsAvailable",
  "jobCompletions", "jobDuration", "cjSchedule", "cjActive", "cjLastSchedule",
  "clusterIP", "externalIP", "ports", "ingressHosts", "ingressAddress",
  "data", "hpaReference", "hpaMinPods", "hpaMaxPods", "hpaCurrentReplicas",
  "vpaTarget", "version", "instanceType", "nodeCost", "ip",
  "bindingRole", "bindingSubjects", "saSecrets", "endpointAddresses",
  "sliceEndpoints", "slicePorts", "scProvisioner", "vaAttacher", "vaVolume",
  "vaNode", "pcValue", "leaseHolder", "webhookCount", "webhookNames",
  "ingressController", "csiModes",
  "eventLastSeen", "eventReason", "eventObject", "eventCount",
]);

/** Short classifier cells, rendered as tag pills. */
const TAG_COLUMNS = new Set([
  "type", "ingressClass", "roles", "vpaUpdateMode", "addressType",
  "scReclaimPolicy", "scBindingMode", "csiAttachRequired", "vaAttached",
  "pcGlobalDefault", "rcHandler",
]);

/** Usage meters: node capacity (cpuUsage/memUsage) and pods (podCpu/podMemory). */
const USAGE_COLUMNS = new Set(["cpuUsage", "memUsage", "podCpu", "podMemory"]);

export const isMonoColumn = (key: string): boolean => MONO_COLUMNS.has(key);
export const isTagColumn = (key: string): boolean => TAG_COLUMNS.has(key);
export const isUsageColumn = (key: string): boolean => USAGE_COLUMNS.has(key);
export const isStatusColumn = (key: string): boolean =>
  key === "status" || key === "phase" || key === "eventType";
export const isContainersColumn = (key: string): boolean => key === "containers";

// ---------------------------------------------------------------------------
// Usage meters
// ---------------------------------------------------------------------------

export interface UsageMeter {
  /** Current usage, humanised. */
  label: string;
  /** What the meter fills towards (limit, request, or node capacity). */
  basisLabel: string;
  /** Fill percentage, or null when there is nothing to measure against. */
  percent: number | null;
  /** Hover text spelling out where the fill comes from. */
  title: string;
}

/** Node capacity meter, from the cost store's metrics cache. */
function nodeMeter(metrics: NodeMetricsInfo | undefined, key: string): UsageMeter | null {
  if (!metrics) return null;

  const cpu = key === "cpuUsage";
  const label = cpu
    ? formatCpu(metrics.cpu_usage)
    : formatBytes(metrics.memory_usage);
  const basisLabel = cpu
    ? formatCpu(metrics.cpu_capacity)
    : formatBytes(metrics.memory_capacity);
  const percent = Math.round(cpu ? metrics.cpu_percent : metrics.memory_percent);

  return {
    label,
    basisLabel,
    percent,
    title: `${label} of ${basisLabel} capacity (${percent}%)`,
  };
}

/** Pod meter: live usage against the pod's limit, or its request. */
function podMeter(resource: Resource, usage: PodUsageInfo | undefined, key: string): UsageMeter | null {
  const cell = key === "podCpu" ? cpuCell(resource, usage) : memoryCell(resource, usage);
  if (!cell) return null;

  // The bar alone cannot say whether it fills towards a limit or a request.
  const parts = [`Using ${cell.label}`];
  parts.push(cell.requestLabel ? `request ${cell.requestLabel}` : "no request");
  parts.push(cell.limitLabel ? `limit ${cell.limitLabel}` : "no limit");
  if (cell.percent !== null) parts.push(`${cell.percent}% of the ${cell.basis}`);

  return {
    label: cell.label,
    basisLabel: cell.basisLabel,
    percent: cell.percent,
    title: parts.join(" · "),
  };
}

/** The meter for a usage column, or null while the numbers are unknown. */
export function usageMeter(resource: Resource, key: string, ctx: CellContext): UsageMeter | null {
  return key === "cpuUsage" || key === "memUsage"
    ? nodeMeter(ctx.nodeMetrics, key)
    : podMeter(resource, ctx.podUsage, key);
}

/**
 * Bar colour: neutral while there is headroom, amber when tight, red when
 * over. Healthy rows stay monochrome on purpose — a table of green bars says
 * nothing, and the one amber bar in it would get lost.
 */
export function usageBarColor(percent: number): string {
  if (percent >= 90) return "var(--status-failed)";
  if (percent >= 70) return "var(--status-pending)";
  return "color-mix(in srgb, var(--text-primary) 38%, var(--bg-primary))";
}

/** Whether the bar's percent label should take the bar's colour (only when it is warning anyone). */
export function usagePercentIsLoud(percent: number): boolean {
  return percent >= 70;
}

/** Counts and ages read right-aligned, so digits line up down the column. */
const RIGHT_ALIGNED_COLUMNS = new Set(["restarts", "age", "eventCount"]);
export const isRightAlignedColumn = (key: string): boolean => RIGHT_ALIGNED_COLUMNS.has(key);
