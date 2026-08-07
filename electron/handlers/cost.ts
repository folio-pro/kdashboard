// Cost handlers — port of src-tauri/src/k8s/cost/* to @kubernetes/client-node.
//
// Commands: get_cost_overview, get_node_costs, get_node_metrics, refresh_pricing
//
// Faithful port notes (Rust is the contract for shapes; frontend is the
// contract for arg keys + return casing — see src/lib/types/cost.ts):
//   - Wire shapes (CostOverview / NamespaceCostSummary / ResourceCost /
//     NodeCostInfo / NodeMetricsInfo) use snake_case field names because the
//     Rust serde structs do NOT set rename_all — the renderer's TS interfaces
//     in src/lib/types/cost.ts mirror that snake_case exactly.
//   - Pricing datasets fetched from the GitHub release assets with If-None-Match
//     conditional GET; cached in memory (24h TTL) + on disk under userData.
//   - get_node_metrics uses metrics.k8s.io NodeMetrics via the client-node
//     Metrics helper (equivalent to the raw /apis/metrics.k8s.io/... request the
//     Rust issues through kube::api::Request).
//   - get_cost_overview joins node costs + pod usage (or pod requests fallback).

import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import { app } from 'electron';
import {
  Metrics,
  type NodeMetricsList as ClientNodeMetricsList,
  type PodMetric,
  type V1Node,
  type V1Pod,
} from '@kubernetes/client-node';

import type { HandlerCtx, HandlerMap } from '../dispatch';
import { getCoreV1Api, kc, onConfigChange } from '../k8s/client';

// ---------------------------------------------------------------------------
// Public wire types (match src/lib/types/cost.ts + the Rust serde structs).
// ---------------------------------------------------------------------------

interface ResourceCost {
  name: string;
  namespace: string;
  kind: string;
  cpu_cores: number;
  memory_bytes: number;
  cpu_cost_hourly: number;
  memory_cost_hourly: number;
  total_cost_hourly: number;
  total_cost_monthly: number;
}

interface NamespaceCostSummary {
  namespace: string;
  total_cpu_cores: number;
  total_memory_gb: number;
  total_cost_hourly: number;
  total_cost_monthly: number;
  workload_count: number;
  workloads: ResourceCost[];
}

interface CostOverview {
  namespaces: NamespaceCostSummary[];
  cluster_cost_hourly: number;
  cluster_cost_monthly: number;
  total_cpu_cores: number;
  total_memory_gb: number;
  cpu_rate_per_core_hour: number;
  memory_rate_per_gb_hour: number;
  source: string; // "cloud-pricing" | "fallback" | "requests"
  fetched_at: string;
}

interface NodeMetricsInfo {
  node_name: string;
  cpu_usage: number; // cores
  cpu_capacity: number; // cores
  cpu_percent: number; // 0-100
  memory_usage: number; // bytes
  memory_capacity: number; // bytes
  memory_percent: number; // 0-100
}

interface NodeCostInfo {
  node_name: string;
  instance_type: string;
  provider: string;
  region: string;
  price_per_hour: number;
  price_per_month: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface NodeInfo {
  name: string;
  instance_type: string;
  provider: string;
  region: string;
  cpu_capacity: number;
  memory_capacity_bytes: number;
}

/** A pod's per-container resource usage (from metrics-server or requests). */
interface PodUsage {
  name: string;
  namespace: string;
  containers: Array<{ cpu: string; memory: string }>;
}

// ---------------------------------------------------------------------------
// Constants (mirrors calculations.rs / nodes.rs)
// ---------------------------------------------------------------------------

const HOURS_PER_MONTH = 730.0;
const FALLBACK_CPU_RATE = 0.0325; // $/core/hr
const FALLBACK_MEM_RATE = 0.0044; // $/GB/hr
const COST_CACHE_TTL_MS = 300_000; // 5 minutes

// ---------------------------------------------------------------------------
// Quantity parsing (port of metrics.rs parse_cpu / parse_memory)
// ---------------------------------------------------------------------------

function parseCpu(cpuStr: string): number {
  if (cpuStr.endsWith('n')) {
    return (Number.parseFloat(cpuStr.slice(0, -1)) || 0) / 1_000_000_000.0;
  }
  if (cpuStr.endsWith('u')) {
    return (Number.parseFloat(cpuStr.slice(0, -1)) || 0) / 1_000_000.0;
  }
  if (cpuStr.endsWith('m')) {
    return (Number.parseFloat(cpuStr.slice(0, -1)) || 0) / 1000.0;
  }
  return Number.parseFloat(cpuStr) || 0;
}

function parseMemory(memStr: string): number {
  if (memStr.endsWith('Ki')) {
    return (Number.parseFloat(memStr.slice(0, -2)) || 0) * 1024.0;
  }
  if (memStr.endsWith('Mi')) {
    return (Number.parseFloat(memStr.slice(0, -2)) || 0) * 1024.0 * 1024.0;
  }
  if (memStr.endsWith('Gi')) {
    return (Number.parseFloat(memStr.slice(0, -2)) || 0) * 1024.0 * 1024.0 * 1024.0;
  }
  if (memStr.endsWith('k')) {
    return (Number.parseFloat(memStr.slice(0, -1)) || 0) * 1000.0;
  }
  if (memStr.endsWith('M')) {
    return (Number.parseFloat(memStr.slice(0, -1)) || 0) * 1_000_000.0;
  }
  if (memStr.endsWith('G')) {
    return (Number.parseFloat(memStr.slice(0, -1)) || 0) * 1_000_000_000.0;
  }
  return Number.parseFloat(memStr) || 0;
}

// ---------------------------------------------------------------------------
// metrics-availability backoff (port of metrics_availability.rs)
// ---------------------------------------------------------------------------

type MetricsKind = 'pods' | 'nodes';

interface AvailabilityState {
  unavailableUntil: number | null; // epoch ms
  consecutiveFailures: number;
}

const BACKOFF_STEPS_SECS = [30, 60, 120, 300];

const availabilityState: Record<MetricsKind, AvailabilityState> = {
  pods: { unavailableUntil: null, consecutiveFailures: 0 },
  nodes: { unavailableUntil: null, consecutiveFailures: 0 },
};

function metricsAvailable(kind: MetricsKind): boolean {
  const s = availabilityState[kind];
  if (s.unavailableUntil === null) return true;
  return Date.now() >= s.unavailableUntil;
}

function markMetricsAvailable(kind: MetricsKind): void {
  const s = availabilityState[kind];
  s.unavailableUntil = null;
  s.consecutiveFailures = 0;
}

function markMetricsUnavailable(kind: MetricsKind): number {
  const s = availabilityState[kind];
  const step = Math.min(s.consecutiveFailures, BACKOFF_STEPS_SECS.length - 1);
  const secs = BACKOFF_STEPS_SECS[step];
  s.consecutiveFailures += 1;
  s.unavailableUntil = Date.now() + secs * 1000;
  return secs;
}

// ---------------------------------------------------------------------------
// Node info retrieval (port of nodes.rs get_node_info + detect_provider)
// ---------------------------------------------------------------------------

function detectProvider(labels: Record<string, string>, instanceType: string): string {
  if (
    'eks.amazonaws.com/nodegroup' in labels ||
    'alpha.eksctl.io/nodegroup-name' in labels ||
    instanceType.includes('.')
  ) {
    return 'aws';
  }
  if (
    'cloud.google.com/gke-nodepool' in labels ||
    instanceType.startsWith('e2-') ||
    instanceType.startsWith('n1-') ||
    instanceType.startsWith('n2-') ||
    instanceType.startsWith('n2d-') ||
    instanceType.startsWith('c2-') ||
    instanceType.startsWith('c2d-') ||
    instanceType.startsWith('c3-') ||
    instanceType.startsWith('t2d-')
  ) {
    return 'gcp';
  }
  if ('kubernetes.azure.com/cluster' in labels || instanceType.startsWith('Standard_')) {
    return 'azure';
  }
  return 'unknown';
}

const NODE_INFO_TTL_MS = 30_000; // 30 seconds

/**
 * Memoized node listing shared by get_cost_overview / get_node_costs /
 * get_node_metrics — each used to issue its own full `listNode`. The promise is
 * cached (concurrent callers coalesce into one request); failures are evicted
 * immediately so the next call retries. Invalidated on context switch.
 */
let nodeInfoCache: { promise: Promise<NodeInfo[]>; expiresAt: number } | null = null;

function getNodeInfo(): Promise<NodeInfo[]> {
  if (nodeInfoCache !== null && nodeInfoCache.expiresAt > Date.now()) {
    return nodeInfoCache.promise;
  }
  const promise = fetchNodeInfo();
  const entry = { promise, expiresAt: Date.now() + NODE_INFO_TTL_MS };
  nodeInfoCache = entry;
  promise.catch(() => {
    // Don't cache failures.
    if (nodeInfoCache === entry) nodeInfoCache = null;
  });
  return promise;
}

async function fetchNodeInfo(): Promise<NodeInfo[]> {
  const core = getCoreV1Api();
  const list = await core.listNode();

  const result: NodeInfo[] = [];
  for (const node of list.items as V1Node[]) {
    const name = node.metadata?.name ?? '';
    const labels = node.metadata?.labels ?? {};

    const instanceType =
      labels['node.kubernetes.io/instance-type'] ??
      labels['beta.kubernetes.io/instance-type'] ??
      '';

    const region =
      labels['topology.kubernetes.io/region'] ??
      labels['failure-domain.beta.kubernetes.io/region'] ??
      '';

    const provider = detectProvider(labels, instanceType);

    const capacity = node.status?.capacity;
    const cpuRaw = capacity?.['cpu'];
    const memRaw = capacity?.['memory'];
    const cpuCap = cpuRaw ? parseCpu(cpuRaw) : 0;
    const memCap = memRaw ? parseMemory(memRaw) : 0;

    if (instanceType !== '') {
      result.push({
        name,
        instance_type: instanceType,
        provider,
        region,
        cpu_capacity: cpuCap,
        memory_capacity_bytes: memCap,
      });
    }
  }
  return result;
}

/**
 * Derive per-core and per-GB rates from cloud pricing (port of
 * nodes.rs resolve_node_rates). Splits node price 60/40 CPU/memory.
 */
function resolveNodeRates(
  nodes: NodeInfo[],
  pricing: Map<string, number>,
): [number, number] {
  for (const node of nodes) {
    const key = `${node.provider}/${node.region}/${node.instance_type}`;
    const pricePerHour = pricing.get(key);
    if (pricePerHour !== undefined) {
      if (node.cpu_capacity > 0 && node.memory_capacity_bytes > 0) {
        const memGb = node.memory_capacity_bytes / (1024.0 * 1024.0 * 1024.0);
        const cpuRate = (pricePerHour * 0.6) / node.cpu_capacity;
        const memRate = (pricePerHour * 0.4) / memGb;
        return [cpuRate, memRate];
      }
    }
  }
  return [FALLBACK_CPU_RATE, FALLBACK_MEM_RATE];
}

// ---------------------------------------------------------------------------
// Pod usage retrieval (metrics-server + requests fallback) — port of metrics.rs
// ---------------------------------------------------------------------------

async function fetchPodMetrics(namespace: string | undefined): Promise<PodUsage[]> {
  if (!metricsAvailable('pods')) {
    throw new Error('metrics-server pods endpoint marked unavailable; using fallback');
  }

  const metrics = new Metrics(kc());
  try {
    const response = await metrics.getPodMetrics(namespace);
    markMetricsAvailable('pods');
    return response.items.map((pm: PodMetric) => ({
      name: pm.metadata.name,
      namespace: pm.metadata.namespace,
      containers: pm.containers.map((c) => ({
        cpu: c.usage.cpu,
        memory: c.usage.memory,
      })),
    }));
  } catch (err) {
    markMetricsUnavailable('pods');
    throw err instanceof Error ? err : new Error(String(err));
  }
}

async function getPodRequests(namespace: string | undefined): Promise<PodUsage[]> {
  const core = getCoreV1Api();
  const list =
    namespace !== undefined
      ? await core.listNamespacedPod({ namespace })
      : await core.listPodForAllNamespaces();

  const result: PodUsage[] = [];
  for (const pod of list.items as V1Pod[]) {
    const name = pod.metadata?.name ?? '';
    const ns = pod.metadata?.namespace ?? '';
    const containers: Array<{ cpu: string; memory: string }> = [];

    for (const c of pod.spec?.containers ?? []) {
      const requests = c.resources?.requests;
      const cpu = requests?.['cpu'] ?? '100m';
      const memory = requests?.['memory'] ?? '128Mi';
      containers.push({ cpu, memory });
    }

    if (containers.length > 0) {
      result.push({ name, namespace: ns, containers });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Pricing resolver (port of pricing.rs)
// ---------------------------------------------------------------------------

const PRICING_BASE_URL =
  'https://github.com/folio-pro/kdashboard/releases/download/pricing-data';
const SUPPORTED_PROVIDERS = ['aws', 'azure', 'gcp'];
const DATASET_TTL_MS = 86_400_000; // 24h
const STALE_RETRY_TTL_MS = 300_000; // 5 minutes
const DISK_CACHE_SUBDIR = 'pricing';
const FETCH_TIMEOUT_MS = 30_000;

interface InstancePrice {
  ondemand_usd_hour?: number | null;
}

interface RawDataset {
  instances: Record<string, Record<string, InstancePrice>>;
}

interface ProviderDataset {
  /** region -> instance_type -> on-demand $/hour */
  prices: Map<string, Map<string, number>>;
  expiresAt: number; // epoch ms
}

interface DatasetMeta {
  etag: string | null;
  /** epoch seconds */
  fetched_at: number;
}

/** In-memory pricing cache: provider -> dataset. Null = never populated. */
let datasetCache: Map<string, ProviderDataset> | null = null;

function pricingBaseUrl(): string {
  return process.env['KDASHBOARD_PRICING_URL'] ?? PRICING_BASE_URL;
}

function cacheRoot(): string {
  // Prompt directive: cache under Electron userData. Falls back to the OS
  // temp/home dir if the app isn't ready (e.g. unit invocation outside Electron).
  let base: string;
  try {
    base = app.getPath('userData');
  } catch {
    base = os.homedir();
  }
  return nodePath.join(base, DISK_CACHE_SUBDIR);
}

function datasetPath(provider: string): string {
  return nodePath.join(cacheRoot(), `${provider}.json`);
}

function metaPath(provider: string): string {
  return nodePath.join(cacheRoot(), `${provider}.meta.json`);
}

function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function metaIsFresh(meta: DatasetMeta): boolean {
  // Rust uses saturating_sub: a future fetched_at clamps age to 0 (treated fresh).
  const age = Math.max(0, nowEpochSeconds() - meta.fetched_at);
  return age < DATASET_TTL_MS / 1000;
}

const DEFAULT_META: DatasetMeta = { etag: null, fetched_at: 0 };

// --- Disk I/O ---

async function readDiskMeta(provider: string): Promise<DatasetMeta | null> {
  try {
    const raw = await fs.readFile(metaPath(provider), 'utf8');
    const parsed = JSON.parse(raw) as Partial<DatasetMeta>;
    return {
      etag: typeof parsed.etag === 'string' ? parsed.etag : null,
      fetched_at: typeof parsed.fetched_at === 'number' ? parsed.fetched_at : 0,
    };
  } catch {
    return null;
  }
}

async function writeDiskMeta(provider: string, meta: DatasetMeta): Promise<void> {
  await atomicWrite(metaPath(provider), JSON.stringify(meta));
}

async function readDiskBody(provider: string): Promise<string | null> {
  try {
    return await fs.readFile(datasetPath(provider), 'utf8');
  } catch {
    return null;
  }
}

async function writeDiskBody(provider: string, body: string): Promise<void> {
  await atomicWrite(datasetPath(provider), body);
}

let tempCounter = 0;

/** Crash-safe replace: write to a unique temp sibling, then rename onto target. */
async function atomicWrite(targetPath: string, contents: string): Promise<void> {
  const dir = nodePath.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${targetPath}.tmp.${process.pid}.${tempCounter++}`;
  try {
    await fs.writeFile(tmpPath, contents);
    await fs.rename(tmpPath, targetPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

// --- Network: conditional fetch with If-None-Match. null body = 304. ---

interface FetchedDataset {
  body: string;
  etag: string | null;
}

async function fetchDatasetConditional(
  provider: string,
  prevEtag: string | null,
): Promise<FetchedDataset | null /* null = 304 not modified */> {
  const url = `${pricingBaseUrl()}/${provider}.json`;
  const headers: Record<string, string> = {};
  if (prevEtag) headers['If-None-Match'] = prevEtag;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 304) return null;
  if (!resp.ok) {
    throw new Error(`pricing fetch returned ${resp.status}`);
  }

  const etag = resp.headers.get('etag');
  const body = await resp.text();
  return { body, etag };
}

// --- Parsing ---

function parseDataset(json: string): ProviderDataset {
  const raw = JSON.parse(json) as RawDataset;
  const prices = new Map<string, Map<string, number>>();
  for (const [region, types] of Object.entries(raw.instances ?? {})) {
    const regionPrices = new Map<string, number>();
    for (const [instanceType, price] of Object.entries(types)) {
      const p = price.ondemand_usd_hour;
      if (typeof p === 'number' && p > 0) {
        regionPrices.set(instanceType, p);
      }
    }
    if (regionPrices.size > 0) {
      prices.set(region, regionPrices);
    }
  }
  return { prices, expiresAt: Date.now() + DATASET_TTL_MS };
}

// --- Memory cache helpers ---

function installDataset(provider: string, ds: ProviderDataset): void {
  if (datasetCache === null) datasetCache = new Map();
  datasetCache.set(provider, ds);
}

function memoryHasFresh(provider: string): boolean {
  const ds = datasetCache?.get(provider);
  return ds !== undefined && ds.expiresAt > Date.now();
}

// --- ensure_dataset_loaded main path (port of pricing.rs) ---

async function ensureDatasetLoaded(provider: string): Promise<boolean> {
  if (memoryHasFresh(provider)) return true;

  const meta = (await readDiskMeta(provider)) ?? DEFAULT_META;

  // Fresh disk cache → load directly, no network.
  if (metaIsFresh(meta)) {
    const body = await readDiskBody(provider);
    if (body !== null) {
      try {
        installDataset(provider, parseDataset(body));
        return true;
      } catch {
        // fresh disk cache corrupt — fall through to refetch
      }
    }
  }

  // Stale or missing disk → conditional fetch.
  try {
    const fetched = await fetchDatasetConditional(provider, meta.etag);
    if (fetched !== null) {
      // 200 — body changed (or first fetch). Persist new body + meta.
      await writeDiskBody(provider, fetched.body).catch(() => undefined);
      const newMeta: DatasetMeta = { etag: fetched.etag, fetched_at: nowEpochSeconds() };
      await writeDiskMeta(provider, newMeta).catch(() => undefined);
      try {
        installDataset(provider, parseDataset(fetched.body));
        return true;
      } catch {
        // downloaded dataset failed to parse — fall through
      }
    } else {
      // 304 — body unchanged. Touch meta so we don't revalidate for 24h.
      const touched: DatasetMeta = { etag: meta.etag, fetched_at: nowEpochSeconds() };
      await writeDiskMeta(provider, touched).catch(() => undefined);
      const body = await readDiskBody(provider);
      if (body !== null) {
        try {
          installDataset(provider, parseDataset(body));
          return true;
        } catch {
          // disk body unreadable after 304 — fall through
        }
      }
    }
  } catch {
    // network failed — fall through to stale disk fallback
  }

  // Last resort: stale disk body with a SHORT TTL so the next call retries.
  const body = await readDiskBody(provider);
  if (body !== null) {
    try {
      const ds = parseDataset(body);
      ds.expiresAt = Date.now() + STALE_RETRY_TTL_MS;
      installDataset(provider, ds);
      return true;
    } catch {
      // unparseable — give up
    }
  }
  return false;
}

/**
 * Resolve `(provider, region, instance_type) -> $/hour` for the requested
 * nodes. Returns null when nothing usable could be loaded (caller falls back to
 * hardcoded rates). Port of pricing.rs resolve_pricing + lookup_prices.
 */
async function resolvePricing(nodes: NodeInfo[]): Promise<Map<string, number> | null> {
  if (nodes.length === 0) return null;

  const providers = Array.from(
    new Set(nodes.map((n) => n.provider).filter((p) => SUPPORTED_PROVIDERS.includes(p))),
  ).sort();

  if (providers.length === 0) return null;

  const loaded = await Promise.all(providers.map((p) => ensureDatasetLoaded(p)));
  const loadedOk = new Set(providers.filter((_, i) => loaded[i]));
  if (loadedOk.size === 0) return null;

  const cache = datasetCache;
  if (cache === null) return null;

  const now = Date.now();
  const prices = new Map<string, number>();
  for (const node of nodes) {
    if (!loadedOk.has(node.provider)) continue;
    const ds = cache.get(node.provider);
    if (ds === undefined || ds.expiresAt <= now) continue;
    const byRegion = ds.prices.get(node.region);
    if (byRegion === undefined) continue;
    const price = byRegion.get(node.instance_type);
    if (price === undefined) continue;
    prices.set(`${node.provider}/${node.region}/${node.instance_type}`, price);
  }

  return prices.size > 0 ? prices : null;
}

// ---------------------------------------------------------------------------
// Cost overview build + cache (port of calculations.rs)
// ---------------------------------------------------------------------------

interface CostCacheEntry {
  data: CostOverview;
  expiresAt: number; // epoch ms
}

/**
 * Overview cache keyed by namespace ('__all__' for the cluster-wide view) so a
 * namespace switch inside the TTL never serves another namespace's data.
 * Bounded: beyond COST_CACHE_MAX_ENTRIES the oldest entry is evicted (Map
 * preserves insertion order). Invalidated on context switch.
 */
const COST_CACHE_ALL_KEY = '__all__';
const COST_CACHE_MAX_ENTRIES = 20;
const costCache = new Map<string, CostCacheEntry>();

async function buildCostFromMetrics(namespace: string | undefined): Promise<CostOverview> {
  // Fetch in parallel: pod metrics + node info.
  const [podMetricsResult, nodesResult] = await Promise.allSettled([
    fetchPodMetrics(namespace),
    getNodeInfo(),
  ]);

  // If metrics-server is unavailable, fall back to pod resource requests.
  let podMetrics: PodUsage[];
  let metricsSource: boolean;
  if (podMetricsResult.status === 'fulfilled') {
    podMetrics = podMetricsResult.value;
    metricsSource = true;
  } else {
    podMetrics = await getPodRequests(namespace);
    metricsSource = false;
  }

  const nodes = nodesResult.status === 'fulfilled' ? nodesResult.value : [];

  const pricing = await resolvePricing(nodes);

  // Determine rates + source.
  let cpuRate: number;
  let memRate: number;
  let source: string;
  if (pricing !== null) {
    if (pricing.size > 0 && nodes.length > 0) {
      const [cr, mr] = resolveNodeRates(nodes, pricing);
      if (Math.abs(cr - FALLBACK_CPU_RATE) > 0.0001) {
        cpuRate = cr;
        memRate = mr;
        source = 'cloud-pricing';
      } else {
        cpuRate = FALLBACK_CPU_RATE;
        memRate = FALLBACK_MEM_RATE;
        source = 'fallback';
      }
    } else {
      cpuRate = FALLBACK_CPU_RATE;
      memRate = FALLBACK_MEM_RATE;
      source = 'fallback';
    }
  } else if (metricsSource) {
    cpuRate = FALLBACK_CPU_RATE;
    memRate = FALLBACK_MEM_RATE;
    source = 'fallback';
  } else {
    cpuRate = FALLBACK_CPU_RATE;
    memRate = FALLBACK_MEM_RATE;
    source = 'requests';
  }

  // Group by namespace.
  const nsMap = new Map<string, ResourceCost[]>();
  for (const pm of podMetrics) {
    let cpuTotal = 0;
    let memTotal = 0;
    for (const c of pm.containers) {
      cpuTotal += parseCpu(c.cpu);
      memTotal += parseMemory(c.memory);
    }
    const cpuCost = cpuTotal * cpuRate;
    const memCost = (memTotal / (1024.0 * 1024.0 * 1024.0)) * memRate;
    const totalHourly = cpuCost + memCost;

    let bucket = nsMap.get(pm.namespace);
    if (bucket === undefined) {
      bucket = [];
      nsMap.set(pm.namespace, bucket);
    }
    bucket.push({
      name: pm.name,
      namespace: pm.namespace,
      kind: 'Pod',
      cpu_cores: cpuTotal,
      memory_bytes: memTotal,
      cpu_cost_hourly: cpuCost,
      memory_cost_hourly: memCost,
      total_cost_hourly: totalHourly,
      total_cost_monthly: totalHourly * HOURS_PER_MONTH,
    });
  }

  const namespaces: NamespaceCostSummary[] = [];
  for (const [ns, workloads] of nsMap) {
    const totalCpu = workloads.reduce((acc, w) => acc + w.cpu_cores, 0);
    const totalMem = workloads.reduce((acc, w) => acc + w.memory_bytes, 0);
    const totalHourly = workloads.reduce((acc, w) => acc + w.total_cost_hourly, 0);
    namespaces.push({
      namespace: ns,
      total_cpu_cores: totalCpu,
      total_memory_gb: totalMem / (1024.0 * 1024.0 * 1024.0),
      total_cost_hourly: totalHourly,
      total_cost_monthly: totalHourly * HOURS_PER_MONTH,
      workload_count: workloads.length,
      workloads,
    });
  }

  namespaces.sort((a, b) => b.total_cost_monthly - a.total_cost_monthly);

  const clusterHourly = namespaces.reduce((acc, n) => acc + n.total_cost_hourly, 0);
  const totalCpu = namespaces.reduce((acc, n) => acc + n.total_cpu_cores, 0);
  const totalMem = namespaces.reduce((acc, n) => acc + n.total_memory_gb, 0);

  return {
    namespaces,
    cluster_cost_hourly: clusterHourly,
    cluster_cost_monthly: clusterHourly * HOURS_PER_MONTH,
    total_cpu_cores: totalCpu,
    total_memory_gb: totalMem,
    cpu_rate_per_core_hour: cpuRate,
    memory_rate_per_gb_hour: memRate,
    source,
    fetched_at: new Date().toISOString(),
  };
}

async function getCostOverview(namespace: string | null | undefined): Promise<CostOverview> {
  const ns =
    namespace && namespace !== 'All Namespaces' && namespace.length > 0
      ? namespace
      : undefined;
  const cacheKey = ns ?? COST_CACHE_ALL_KEY;

  // Cache check (per-namespace entry, 5 min TTL).
  const hit = costCache.get(cacheKey);
  if (hit !== undefined && hit.expiresAt > Date.now()) {
    return hit.data;
  }

  const result = await buildCostFromMetrics(ns);

  // Re-insert so the entry moves to the back of the eviction order.
  costCache.delete(cacheKey);
  costCache.set(cacheKey, { data: result, expiresAt: Date.now() + COST_CACHE_TTL_MS });
  if (costCache.size > COST_CACHE_MAX_ENTRIES) {
    const oldest = costCache.keys().next().value;
    if (oldest !== undefined) costCache.delete(oldest);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Node metrics (port of node_metrics.rs get_node_metrics)
// ---------------------------------------------------------------------------

async function getNodeMetrics(): Promise<NodeMetricsInfo[]> {
  if (!metricsAvailable('nodes')) {
    throw new Error('metrics-server nodes endpoint marked unavailable; skipping');
  }

  const metrics = new Metrics(kc());
  const [metricsResult, nodes] = await Promise.all([
    (async (): Promise<ClientNodeMetricsList> => metrics.getNodeMetrics())().then(
      (r) => ({ ok: true as const, value: r }),
      (e: unknown) => ({ ok: false as const, error: e }),
    ),
    getNodeInfo().catch(() => [] as NodeInfo[]),
  ]);

  if (!metricsResult.ok) {
    markMetricsUnavailable('nodes');
    const err = metricsResult.error;
    throw err instanceof Error ? err : new Error(String(err));
  }
  markMetricsAvailable('nodes');
  const response = metricsResult.value;

  const capacityMap = new Map<string, [number, number]>();
  for (const n of nodes) {
    capacityMap.set(n.name, [n.cpu_capacity, n.memory_capacity_bytes]);
  }

  return response.items.map((m) => {
    const [cpuCap, memCap] = capacityMap.get(m.metadata.name) ?? [0, 0];
    const cpuUsage = parseCpu(m.usage.cpu);
    const memUsage = parseMemory(m.usage.memory);
    const cpuPct = cpuCap > 0 ? Math.min((cpuUsage / cpuCap) * 100.0, 100.0) : 0;
    const memPct = memCap > 0 ? Math.min((memUsage / memCap) * 100.0, 100.0) : 0;
    return {
      node_name: m.metadata.name,
      cpu_usage: cpuUsage,
      cpu_capacity: cpuCap,
      cpu_percent: Math.round(cpuPct * 10.0) / 10.0,
      memory_usage: memUsage,
      memory_capacity: memCap,
      memory_percent: Math.round(memPct * 10.0) / 10.0,
    };
  });
}

// ---------------------------------------------------------------------------
// Node costs (port of node_metrics.rs get_node_costs)
// ---------------------------------------------------------------------------

async function getNodeCosts(): Promise<NodeCostInfo[]> {
  const nodes = await getNodeInfo().catch(() => [] as NodeInfo[]);
  const pricing = (await resolvePricing(nodes)) ?? new Map<string, number>();

  return nodes.map((node) => {
    const key = `${node.provider}/${node.region}/${node.instance_type}`;
    const pricePerHour = pricing.get(key) ?? 0;
    return {
      node_name: node.name,
      instance_type: node.instance_type,
      provider: node.provider,
      region: node.region,
      price_per_hour: pricePerHour,
      price_per_month: pricePerHour * HOURS_PER_MONTH,
    };
  });
}

// ---------------------------------------------------------------------------
// refresh_pricing (port of pricing.rs refresh_pricing)
// ---------------------------------------------------------------------------

function refreshPricing(): void {
  // Force-clear the in-memory pricing cache and the cost overview cache. Disk
  // state is left in place — the next call refetches conditionally (cheap 304).
  datasetCache = null;
  costCache.clear();
}

/**
 * Background pricing revalidation — port of pricing.rs spawn_periodic_refresh.
 * Every 24h, conditionally re-fetch each ALREADY-CACHED provider's dataset
 * (cheap 304 when unchanged) so pricing never goes stale. Providers that were
 * never loaded are skipped (mirrors Rust known_providers()), so a GCP-only
 * cluster never fetches aws/azure. The first tick is at +24h; startup itself
 * loads lazily on the first cost request. Returns a stop function.
 */
export function startPeriodicRefresh(): () => void {
  const timer = setInterval(() => {
    void (async () => {
      const cached = datasetCache ? [...datasetCache.keys()] : [];
      for (const provider of cached) {
        try {
          await ensureDatasetLoaded(provider);
        } catch {
          // best-effort: a failed revalidation keeps the existing cached data
        }
      }
    })();
  }, DATASET_TTL_MS);
  // Don't keep the process alive solely for this timer.
  timer.unref?.();
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function register(handlers: HandlerMap, _ctx: HandlerCtx): void {
  // Cluster-scoped caches must not survive a kubeconfig/context switch.
  onConfigChange(() => {
    costCache.clear();
    nodeInfoCache = null;
  });

  handlers.set('get_cost_overview', async (args) => {
    const namespace =
      typeof args['namespace'] === 'string'
        ? (args['namespace'] as string)
        : args['namespace'] === null
          ? null
          : undefined;
    return getCostOverview(namespace);
  });

  handlers.set('get_node_costs', async () => getNodeCosts());

  handlers.set('get_node_metrics', async () => getNodeMetrics());

  handlers.set('refresh_pricing', async () => {
    refreshPricing();
    // Rust returns Result<(), String> -> unit; the renderer ignores the value.
    return null;
  });
}
