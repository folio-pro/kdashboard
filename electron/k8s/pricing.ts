// Cloud pricing for the cluster's nodes: instance types from node labels,
// per-provider datasets (GitHub release assets, conditional GET, 24h TTL,
// disk cache under userData) and the $/core/hour + $/GB/hour rates the cost
// and rightsizing views quote. Extracted from handlers/cost.ts, which mixed
// this with the cost overview itself.

import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import type { V1Node } from '@kubernetes/client-node';

import { atomicWrite } from '../util/fs-atomic.js';
import { getCoreV1Api, onConfigChange } from './client.js';
import { parseCpu, parseMemory } from './quantity.js';

export interface NodeInfo {
  name: string;
  instance_type: string;
  provider: string;
  region: string;
  cpu_capacity: number;
  memory_capacity_bytes: number;
}

export const HOURS_PER_MONTH = 730.0;
export const FALLBACK_CPU_RATE = 0.0325; // $/core/hr
export const FALLBACK_MEM_RATE = 0.0044; // $/GB/hr

// ---------------------------------------------------------------------------
// Node info retrieval
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

export function getNodeInfo(): Promise<NodeInfo[]> {
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

    // Every node is listed — get_node_metrics needs the capacity of nodes
    // without a cloud instance-type label too (kind, bare metal, k3s), or their
    // CPU/memory meters read 0%. Pricing lookups skip nodes with no
    // instance_type (see resolvePricing / resolveNodeRates).
    result.push({
      name,
      instance_type: instanceType,
      provider,
      region,
      cpu_capacity: cpuCap,
      memory_capacity_bytes: memCap,
    });
  }
  return result;
}

/**
 * Derive per-core and per-GB rates from cloud pricing. Splits the node price
 * 60/40 across CPU and memory.
 */
export function resolveNodeRates(
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

onConfigChange(() => {
  nodeInfoCache = null;
});

// ---------------------------------------------------------------------------
// Pricing resolver
// ---------------------------------------------------------------------------

const PRICING_BASE_URL =
  'https://github.com/folio-pro/kdashboard/releases/download/pricing-data';
const SUPPORTED_PROVIDERS = ['aws', 'azure', 'gcp'];
export const DATASET_TTL_MS = 86_400_000; // 24h
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

/**
 * Cache under Electron's userData. Resolved lazily and through a dynamic
 * import: this module is reached from handlers the integration suite loads
 * under plain Node, where a static `import { app } from 'electron'` fails at
 * link time. Outside Electron the cache lands under the home directory.
 */
let cacheRootCached: string | null = null;
async function cacheRoot(): Promise<string> {
  if (cacheRootCached) return cacheRootCached;
  let base = os.homedir();
  try {
    const electron = (await import('electron')) as { app?: { getPath(name: string): string } };
    if (electron.app) base = electron.app.getPath('userData');
  } catch {
    // plain Node — keep the home directory
  }
  cacheRootCached = nodePath.join(base, DISK_CACHE_SUBDIR);
  return cacheRootCached;
}

async function datasetPath(provider: string): Promise<string> {
  return nodePath.join(await cacheRoot(), `${provider}.json`);
}

async function metaPath(provider: string): Promise<string> {
  return nodePath.join(await cacheRoot(), `${provider}.meta.json`);
}

function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function metaIsFresh(meta: DatasetMeta): boolean {
  // A future fetched_at clamps the age to 0, i.e. it counts as fresh.
  const age = Math.max(0, nowEpochSeconds() - meta.fetched_at);
  return age < DATASET_TTL_MS / 1000;
}

const DEFAULT_META: DatasetMeta = { etag: null, fetched_at: 0 };

// --- Disk I/O ---

async function readDiskMeta(provider: string): Promise<DatasetMeta | null> {
  try {
    const raw = await fs.readFile(await metaPath(provider), 'utf8');
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
  await atomicWrite(await metaPath(provider), JSON.stringify(meta));
}

async function readDiskBody(provider: string): Promise<string | null> {
  try {
    return await fs.readFile(await datasetPath(provider), 'utf8');
  } catch {
    return null;
  }
}

async function writeDiskBody(provider: string, body: string): Promise<void> {
  await atomicWrite(await datasetPath(provider), body);
}

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

// --- ensure_dataset_loaded main path ---

export async function ensureDatasetLoaded(provider: string): Promise<boolean> {
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
 * hardcoded rates).
 */
export async function resolvePricing(nodes: NodeInfo[]): Promise<Map<string, number> | null> {
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


/** Drop the in-memory pricing cache; disk state stays (the next load is a cheap 304). */
export function clearPricingCache(): void {
  datasetCache = null;
}

/** The providers whose datasets are currently loaded. */
export function loadedProviders(): string[] {
  return datasetCache ? [...datasetCache.keys()] : [];
}

/**
 * The $/core/hour and $/GB/hour the cost view prices with — cloud pricing
 * when the node instance types resolve, the fallback rates otherwise. Shared
 * with rightsizing so both views quote the same money.
 */
export async function currentRates(): Promise<{ cpu: number; memory: number; source: 'cloud-pricing' | 'fallback' }> {
  let nodes: NodeInfo[] = [];
  try {
    nodes = await getNodeInfo();
  } catch {
    nodes = [];
  }
  const pricing = await resolvePricing(nodes);
  if (pricing !== null && pricing.size > 0 && nodes.length > 0) {
    const [cpu, memory] = resolveNodeRates(nodes, pricing);
    if (Math.abs(cpu - FALLBACK_CPU_RATE) > 0.0001) return { cpu, memory, source: 'cloud-pricing' };
  }
  return { cpu: FALLBACK_CPU_RATE, memory: FALLBACK_MEM_RATE, source: 'fallback' };
}

/**
 * Background pricing revalidation. Every 24h, conditionally re-fetch each
 * ALREADY-CACHED provider's dataset (cheap 304 when unchanged) so pricing never
 * goes stale. Providers that were never loaded are skipped, so a GCP-only
 * cluster never fetches aws/azure. The first tick is at +24h; startup itself
 * loads lazily on the first cost request. Returns a stop function.
 */
export function startPeriodicRefresh(): () => void {
  const timer = setInterval(() => {
    void (async () => {
      for (const provider of loadedProviders()) {
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
