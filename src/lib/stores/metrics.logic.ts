import type { PodUsageInfo, Resource } from "$lib/types";

/** Pod usage is re-fetched at most this often (metrics-server scrapes ~60s). */
export const POD_METRICS_TTL_MS = 20_000;

/** Map key for a pod's usage entry. */
export function podKey(namespace: string | undefined | null, name: string): string {
  return `${namespace ?? ""}/${name}`;
}

export interface UsageCell {
  /** Absolute usage, already humanised ("120m", "512 Mi"). */
  label: string;
  /** Usage as a percentage of `basis`; null when the pod declares neither. */
  percent: number | null;
  /**
   * What the bar is measured against. A limit is the ceiling the kubelet
   * enforces, so it wins when present; a request is what the scheduler
   * reserved and is the next best yardstick.
   */
  basis: "limit" | "request" | null;
  /** The basis value, humanised. Empty when there is no basis. */
  basisLabel: string;
  /** Request, humanised, for the tooltip. Empty when nothing is requested. */
  requestLabel: string;
  /** Limit, humanised, for the tooltip. Empty when nothing is limited. */
  limitLabel: string;
}

const KIBI = 1024;

/** CPU cores -> "120m" below one core, "1.50" above. Zero keeps the unit ("0m")
 *  so a cell reads "0m / 10m" instead of mixing scales. */
export function formatCpu(cores: number): string {
  if (cores <= 0) return "0m";
  if (cores < 1) return `${Math.round(cores * 1000)}m`;
  // Whole cores print bare ("4"), fractions keep two decimals ("1.50") — a
  // node capacity of "4.00" reads like a measurement rather than a limit.
  return cores % 1 === 0 ? cores.toFixed(0) : cores.toFixed(2);
}

/** Bytes -> the largest binary unit that keeps the number readable. */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0";
  const units = ["B", "Ki", "Mi", "Gi", "Ti"];
  let value = bytes;
  let unit = 0;
  while (value >= KIBI && unit < units.length - 1) {
    value /= KIBI;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

// resource.Quantity suffixes. Mirrors electron/k8s/quantity.ts — the renderer
// and the main process cannot share a module, so the two tables must agree.
const BINARY: Record<string, number> = {
  Ki: KIBI,
  Mi: KIBI ** 2,
  Gi: KIBI ** 3,
  Ti: KIBI ** 4,
  Pi: KIBI ** 5,
  Ei: KIBI ** 6,
};

/** `m` is milli — legal on memory quantities, and one thousandth of a byte. */
const DECIMAL: Record<string, number> = { m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };

function parseQuantity(q: string): number {
  // Two-character binary suffixes first: "Mi" also ends with "M".
  for (const [suffix, factor] of Object.entries(BINARY)) {
    if (q.endsWith(suffix)) return (Number.parseFloat(q.slice(0, -suffix.length)) || 0) * factor;
  }
  for (const [suffix, factor] of Object.entries(DECIMAL)) {
    if (q.endsWith(suffix)) return (Number.parseFloat(q.slice(0, -suffix.length)) || 0) * factor;
  }
  return Number.parseFloat(q) || 0;
}

/** CPU quantity string ("250m", "2", "1500u") -> cores. */
export function parseCpuQuantity(q: string): number {
  if (q.endsWith("n")) return (Number.parseFloat(q) || 0) / 1e9;
  if (q.endsWith("u")) return (Number.parseFloat(q) || 0) / 1e6;
  return parseQuantity(q);
}

/** Memory quantity string ("128Mi", "1Gi", "512M", "1Pi") -> bytes. */
export function parseMemoryQuantity(q: string): number {
  return parseQuantity(q);
}

interface ContainerSpec {
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
}

/** Sum one side of the container resource block across a pod's containers. */
function sumResources(
  resource: Resource,
  side: "requests" | "limits",
): { cpu: number; memory: number } {
  const containers = (resource.spec?.containers as ContainerSpec[] | undefined) ?? [];
  let cpu = 0;
  let memory = 0;
  for (const c of containers) {
    const values = c.resources?.[side];
    if (!values) continue;
    if (values.cpu) cpu += parseCpuQuantity(values.cpu);
    if (values.memory) memory += parseMemoryQuantity(values.memory);
  }
  return { cpu, memory };
}

/**
 * Sum a pod's container requests. Init containers are excluded: they do not run
 * alongside the app containers, so counting them would overstate the request
 * the scheduler actually reserved.
 */
export function podRequests(resource: Resource): { cpu: number; memory: number } {
  return sumResources(resource, "requests");
}

/** Sum a pod's container limits — the ceiling the kubelet actually enforces. */
export function podLimits(resource: Resource): { cpu: number; memory: number } {
  return sumResources(resource, "limits");
}

/**
 * Build one usage cell. The bar is measured against the limit when the pod has
 * one (that is the number that gets it throttled or OOM-killed) and falls back
 * to the request; with neither, there is a value but nothing to fill against.
 */
function buildCell(
  used: number,
  request: number,
  limit: number,
  format: (v: number) => string,
): UsageCell {
  const basis = limit > 0 ? "limit" : request > 0 ? "request" : null;
  const basisValue = basis === "limit" ? limit : basis === "request" ? request : 0;
  return {
    label: format(used),
    percent: basisValue > 0 ? Math.round((used / basisValue) * 100) : null,
    basis,
    basisLabel: basisValue > 0 ? format(basisValue) : "",
    requestLabel: request > 0 ? format(request) : "",
    limitLabel: limit > 0 ? format(limit) : "",
  };
}

/** Build the CPU cell for a pod row, or null when no usage is known. */
export function cpuCell(resource: Resource, usage: PodUsageInfo | undefined): UsageCell | null {
  if (!usage) return null;
  return buildCell(usage.cpu_cores, podRequests(resource).cpu, podLimits(resource).cpu, formatCpu);
}

/** Build the memory cell for a pod row, or null when no usage is known. */
export function memoryCell(resource: Resource, usage: PodUsageInfo | undefined): UsageCell | null {
  if (!usage) return null;
  return buildCell(
    usage.memory_bytes,
    podRequests(resource).memory,
    podLimits(resource).memory,
    formatBytes,
  );
}

/**
 * Bar colour for a usage meter: green under pressure, amber when tight, red
 * when over. Lives here with the rest of the usage formatting so a detail
 * panel does not have to reach into the table layer for it.
 */
export function usageBarColor(percent: number): string {
  if (percent >= 90) return "var(--status-failed)";
  if (percent >= 70) return "var(--status-pending)";
  return "var(--status-running)";
}

export class MetricsStoreLogic {
  /** Pod usage keyed by `${namespace}/${name}`. */
  podUsage: Record<string, PodUsageInfo> = {};
  /** False once a fetch reports the cluster has no metrics-server. */
  podMetricsAvailable = true;
  /** Why metrics are unavailable (empty while available). */
  unavailableReason = "";
  _loading = false;
  _fetchedAt = 0;
  /** Monotonic id of the newest in-flight fetch; older responses are dropped. */
  _requestId = 0;

  getPodUsage(namespace: string | undefined | null, name: string): PodUsageInfo | undefined {
    return this.podUsage[podKey(namespace, name)];
  }

  /** True when the cached usage is older than the TTL (or was never fetched). */
  isStale(now: number): boolean {
    return this._fetchedAt === 0 || now - this._fetchedAt >= POD_METRICS_TTL_MS;
  }

  applyPodUsage(pods: PodUsageInfo[], now: number): void {
    const map: Record<string, PodUsageInfo> = {};
    for (const p of pods) map[podKey(p.namespace, p.name)] = p;
    this.podUsage = map;
    this._fetchedAt = now;
  }

  reset(): void {
    this.podUsage = {};
    this.podMetricsAvailable = true;
    this.unavailableReason = "";
    this._loading = false;
    this._fetchedAt = 0;
    // Bumping the id invalidates any response still in flight for the cluster
    // or namespace we just left.
    this._requestId += 1;
  }
}
