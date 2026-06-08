// Security + CRD handler group — ports the Tauri "security" and "crd" commands
// to @kubernetes/client-node.
//
// Rust sources ported (faithful 1:1):
//   - src-tauri/src/k8s/security.rs
//       get_security_overview (scanner detection + per-pod posture) and
//       scan_single_image (single-image scan)
//   - src-tauri/src/k8s/crd/discovery.rs   (discover_crds + sensitive-field deny list)
//   - src-tauri/src/k8s/crd/listing.rs     (list_crd_resources + paging)
//   - src-tauri/src/k8s/crd/counts.rs      (get_crd_counts, concurrency-limited)
//   - src-tauri/src/k8s/crd/schema.rs      (additionalPrinterColumns + heuristics)
//   - src-tauri/src/k8s/crd/types.rs       (extract_conditions)
//   - src-tauri/src/commands/k8s_commands.rs (the #[tauri::command] wrappers)
//
// Commands implemented (EXACT Tauri command strings):
//   - get_security_overview  (args: { namespace?: string | null })
//   - scan_image             (args: { image: string })
//   - discover_crds          (args: {})
//   - list_crd_resources     (args: { group, version, kind, plural, scope, namespace? })
//   - get_crd_counts         (args: { crds: CrdInfo[], namespace?: string | null })
//   - get_crd_conditions     (args: { resource: Resource })
//
// Wire-casing notes (frontend is source of truth):
//   - get_security_overview: AsyncLoadStore._load sends { namespace } (string | null).
//   - scan_image: arg key `image` (Rust param `image`).
//   - list_crd_resources: src/lib/stores/k8s.svelte.ts sends
//       { group, version, kind, plural, scope, namespace } — all camel-less keys,
//       namespace is `null` for Cluster-scoped CRDs.
//   - get_crd_counts: sends { crds, namespace }; crds is CrdInfo[] (snake_case
//       `short_names`); result is Record<string, number> keyed `group/kind`.
//   - get_crd_conditions: not currently called from src/ but kept faithful;
//       returns StatusCondition[] with serde renames (`type`, optional reason /
//       message / last_transition_time omitted when absent).
//
// Return SHAPES mirror serde wire-casing in src-tauri (snake_case structs;
// StatusCondition renames `type_`->`type`; Resource omits spec/status/data/type
// when absent — `skip_serializing_if = Option::is_none`).

import { spawn } from 'node:child_process';

import {
  ApiextensionsV1Api,
  CustomObjectsApi,
  type V1CustomResourceDefinition,
  type V1Pod,
} from '@kubernetes/client-node';

import type { HandlerCtx, HandlerMap } from '../dispatch';
import { getCoreV1Api, makeApiClient } from '../k8s/client';

// ===========================================================================
// Result types — mirror the serde wire-casing of the Rust structs.
// ===========================================================================

/** security.rs VulnerabilityCounts (all snake_case, u32 -> number). */
interface VulnerabilityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
}

/** security.rs ImageScanResult. */
interface ImageScanResult {
  image: string;
  vulns: VulnerabilityCounts;
  scanned_at: string;
}

/** security.rs PodSecurityInfo. */
interface PodSecurityInfo {
  name: string;
  namespace: string;
  images: ImageScanResult[];
  total_vulns: VulnerabilityCounts;
  compliant: boolean;
}

/** security.rs SecurityOverview. */
interface SecurityOverview {
  pods: PodSecurityInfo[];
  total_vulns: VulnerabilityCounts;
  total_images_scanned: number;
  compliant_pods: number;
  non_compliant_pods: number;
  scanner: string; // "trivy" | "grype" | "none"
  fetched_at: string;
}

/** crd/types.rs CrdInfo. */
interface CrdInfo {
  group: string;
  version: string;
  kind: string;
  plural: string;
  scope: string; // "Namespaced" | "Cluster"
  short_names: string[];
}

/** crd/types.rs CrdGroup. */
interface CrdGroup {
  group: string;
  resources: CrdInfo[];
}

/** crd/types.rs CrdColumn. */
interface CrdColumn {
  name: string;
  json_path: string;
  column_type: string;
  description: string;
}

/**
 * resources/types.rs ResourceMetadata — Option fields are emitted as
 * undefined-omitted / null by serde, but `skip_serializing_if` is NOT set on
 * metadata fields, so serde serializes Option::None as JSON `null`. We mirror
 * that: null for absent name/namespace/uid/etc.
 */
interface ResourceMetadata {
  name: string | null;
  namespace: string | null;
  uid: string | null;
  resource_version: string | null;
  labels: Record<string, string> | null;
  annotations: Record<string, string> | null;
  creation_timestamp: string | null;
  owner_references: unknown | null;
}

/**
 * resources/types.rs Resource — spec/status/data/type are
 * `skip_serializing_if = Option::is_none`, so they are OMITTED entirely when
 * absent (not null). `type_` serializes as `type`.
 */
interface Resource {
  api_version: string;
  kind: string;
  metadata: ResourceMetadata;
  spec?: unknown;
  status?: unknown;
  data?: unknown;
  type?: string;
}

/** crd/types.rs CrdResourceList. */
interface CrdResourceList {
  items: Resource[];
  columns: CrdColumn[];
}

/**
 * crd/types.rs StatusCondition — `type_` renames to `type`; reason / message /
 * last_transition_time are `skip_serializing_if = Option::is_none` (omitted).
 */
interface StatusCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  last_transition_time?: string;
}

// ===========================================================================
// Security: scanner detection + image scanning (trivy / grype shell-outs).
// ===========================================================================

type Scanner = 'trivy' | 'grype' | 'none';

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError: boolean;
}

/** Run a binary, capturing stdout/stderr/exit. Never rejects. */
function runCommand(cmd: string, args: string[]): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ code: null, stdout: '', stderr: '', spawnError: true });
      return;
    }
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', () => {
      resolve({ code: null, stdout, stderr, spawnError: true });
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr, spawnError: false });
    });
  });
}

/** Mirror Rust detect_scanner(): probe `trivy --version`, then `grype version`. */
async function detectScanner(): Promise<Scanner> {
  const trivy = await runCommand('trivy', ['--version']);
  if (!trivy.spawnError && trivy.code === 0) {
    return 'trivy';
  }
  const grype = await runCommand('grype', ['version']);
  if (!grype.spawnError && grype.code === 0) {
    return 'grype';
  }
  return 'none';
}

function emptyCounts(): VulnerabilityCounts {
  return { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
}

function mergeCounts(into: VulnerabilityCounts, other: VulnerabilityCounts): void {
  into.critical += other.critical;
  into.high += other.high;
  into.medium += other.medium;
  into.low += other.low;
  into.unknown += other.unknown;
}

function tallySeverity(counts: VulnerabilityCounts, severity: string): void {
  switch (severity.toUpperCase()) {
    case 'CRITICAL':
      counts.critical += 1;
      break;
    case 'HIGH':
      counts.high += 1;
      break;
    case 'MEDIUM':
      counts.medium += 1;
      break;
    case 'LOW':
      counts.low += 1;
      break;
    default:
      counts.unknown += 1;
      break;
  }
}

interface TrivyOutput {
  Results?: Array<{ Vulnerabilities?: Array<{ Severity?: string }> | null }> | null;
}

interface GrypeOutput {
  matches?: Array<{ vulnerability?: { severity?: string } }> | null;
}

async function scanImageTrivy(image: string): Promise<VulnerabilityCounts> {
  const out = await runCommand('trivy', [
    'image',
    '--format',
    'json',
    '--quiet',
    '--timeout',
    '60s',
    image,
  ]);
  if (out.spawnError || out.code !== 0) {
    throw new Error(`trivy scan failed: ${out.stderr}`);
  }
  const parsed = JSON.parse(out.stdout) as TrivyOutput;
  const counts = emptyCounts();
  for (const result of parsed.Results ?? []) {
    for (const v of result.Vulnerabilities ?? []) {
      tallySeverity(counts, v.Severity ?? '');
    }
  }
  return counts;
}

async function scanImageGrype(image: string): Promise<VulnerabilityCounts> {
  const out = await runCommand('grype', [image, '-o', 'json', '--quiet']);
  if (out.spawnError || out.code !== 0) {
    throw new Error(`grype scan failed: ${out.stderr}`);
  }
  const parsed = JSON.parse(out.stdout) as GrypeOutput;
  const counts = emptyCounts();
  for (const m of parsed.matches ?? []) {
    tallySeverity(counts, m.vulnerability?.severity ?? '');
  }
  return counts;
}

async function scanImage(scanner: Scanner, image: string): Promise<VulnerabilityCounts> {
  switch (scanner) {
    case 'trivy':
      return scanImageTrivy(image);
    case 'grype':
      return scanImageGrype(image);
    default:
      throw new Error('No scanner available');
  }
}

// ---------------------------------------------------------------------------
// Scan cache — mirror Rust SCAN_CACHE (process-global, 5 min TTL).
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 300_000; // 5 min

interface ScanCache {
  results: Map<string, ImageScanResult>;
  expiresAt: number; // epoch ms
}

let scanCache: ScanCache | null = null;

// ---------------------------------------------------------------------------
// Pod image extraction — mirror get_pod_images().
// ---------------------------------------------------------------------------

/** Returns [podName, namespace, uniqueImages][] for the (optional) namespace. */
async function getPodImages(
  namespace: string | undefined,
): Promise<Array<[string, string, string[]]>> {
  const core = getCoreV1Api();
  let pods: V1Pod[];
  if (namespace) {
    const list = await core.listNamespacedPod({ namespace });
    pods = list.items;
  } else {
    const list = await core.listPodForAllNamespaces();
    pods = list.items;
  }

  const result: Array<[string, string, string[]]> = [];
  for (const pod of pods) {
    const name = pod.metadata?.name ?? '';
    const ns = pod.metadata?.namespace ?? '';
    const images: string[] = [];
    const spec = pod.spec;
    if (spec) {
      for (const container of spec.containers ?? []) {
        const image = container.image;
        if (image && !images.includes(image)) {
          images.push(image);
        }
      }
      for (const container of spec.initContainers ?? []) {
        const image = container.image;
        if (image && !images.includes(image)) {
          images.push(image);
        }
      }
    }
    result.push([name, ns, images]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// get_security_overview — faithful port.
// ---------------------------------------------------------------------------

function normalizeNamespace(namespace: string | undefined): string | undefined {
  if (namespace === undefined || namespace === null) return undefined;
  if (namespace === 'All Namespaces' || namespace.length === 0) return undefined;
  return namespace;
}

async function getSecurityOverview(namespace: string | undefined): Promise<SecurityOverview> {
  const scanner = await detectScanner();
  const ns = normalizeNamespace(namespace);

  const podImages = await getPodImages(ns);

  // Collect unique images.
  const uniqueSet = new Set<string>();
  for (const [, , images] of podImages) {
    for (const img of images) uniqueSet.add(img);
  }
  const uniqueImages = [...uniqueSet];

  const imageResults = new Map<string, ImageScanResult>();
  const now = new Date().toISOString();

  // Reuse cached scans that are still fresh.
  if (scanCache && scanCache.expiresAt > Date.now()) {
    for (const img of uniqueImages) {
      const cached = scanCache.results.get(img);
      if (cached) imageResults.set(img, cached);
    }
  }

  // Scan images not in cache (sequential, mirroring the Rust loop).
  if (scanner !== 'none') {
    for (const img of uniqueImages) {
      if (imageResults.has(img)) continue;
      try {
        const vulns = await scanImage(scanner, img);
        imageResults.set(img, { image: img, vulns, scanned_at: now });
      } catch {
        // Failed scan -> empty result (faithful to Rust).
        imageResults.set(img, { image: img, vulns: emptyCounts(), scanned_at: now });
      }
    }
  }

  // Update cache.
  scanCache = {
    results: new Map(imageResults),
    expiresAt: Date.now() + CACHE_TTL_MS,
  };

  // Per-pod posture.
  const pods: PodSecurityInfo[] = [];
  const overallVulns = emptyCounts();
  let compliantCount = 0;
  let nonCompliantCount = 0;

  for (const [podName, podNs, images] of podImages) {
    const podVulns = emptyCounts();
    const podImagesResults: ImageScanResult[] = [];
    for (const img of images) {
      const result = imageResults.get(img);
      if (result) {
        mergeCounts(podVulns, result.vulns);
        podImagesResults.push(result);
      }
    }

    const compliant = podVulns.critical === 0 && podVulns.high === 0;
    if (compliant) compliantCount += 1;
    else nonCompliantCount += 1;

    mergeCounts(overallVulns, podVulns);

    pods.push({
      name: podName,
      namespace: podNs,
      images: podImagesResults,
      total_vulns: podVulns,
      compliant,
    });
  }

  // Sort: non-compliant first, then by critical desc, then high desc.
  // Rust sorts by `compliant` ascending (false < true), so non-compliant first.
  pods.sort((a, b) => {
    const byCompliant = Number(a.compliant) - Number(b.compliant);
    if (byCompliant !== 0) return byCompliant;
    const byCritical = b.total_vulns.critical - a.total_vulns.critical;
    if (byCritical !== 0) return byCritical;
    return b.total_vulns.high - a.total_vulns.high;
  });

  return {
    pods,
    total_vulns: overallVulns,
    total_images_scanned: imageResults.size,
    compliant_pods: compliantCount,
    non_compliant_pods: nonCompliantCount,
    scanner,
    fetched_at: now,
  };
}

async function scanSingleImage(image: string): Promise<ImageScanResult> {
  const scanner = await detectScanner();
  if (scanner === 'none') {
    throw new Error('No vulnerability scanner found. Install trivy or grype.');
  }
  const vulns = await scanImage(scanner, image);
  return { image, vulns, scanned_at: new Date().toISOString() };
}

// ===========================================================================
// CRD: sensitive-field deny list (mirror discovery.rs).
// ===========================================================================

const SENSITIVE_FIELD_PATTERNS = [
  'password',
  'secret',
  'token',
  'key',
  'credential',
  'apikey',
  'certificate',
  'private',
  'passphrase',
];

function isSensitiveField(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_FIELD_PATTERNS.some((p) => lower.includes(p));
}

// ===========================================================================
// discover_crds — list CustomResourceDefinitions grouped by API group.
// ===========================================================================
//
// The Rust used kube::discovery::Discovery (which enumerates ALL groups and
// then filters out the built-in ones via a deny-list). Listing CRD objects via
// apiextensions.k8s.io is the faithful @kubernetes/client-node analog: CRD
// objects are by definition the user-defined groups, so no built-in deny-list
// is needed. We emit one CrdInfo per CRD using its storage/served version
// (the discovery API's "recommended" version), matching the original's
// "one entry per recommended resource" behaviour.

interface CrdSpecVersion {
  name?: string;
  served?: boolean;
  storage?: boolean;
}

/** Pick the discovery-preferred version: storage version, else first served, else first. */
function preferredVersion(crd: V1CustomResourceDefinition): string | undefined {
  const versions = (crd.spec?.versions ?? []) as CrdSpecVersion[];
  if (versions.length === 0) return undefined;
  const storage = versions.find((v) => v.storage === true && v.name);
  if (storage?.name) return storage.name;
  const served = versions.find((v) => v.served === true && v.name);
  if (served?.name) return served.name;
  return versions[0]?.name;
}

async function discoverCrds(): Promise<CrdGroup[]> {
  const apiext = makeApiClient(ApiextensionsV1Api);
  const list = await apiext.listCustomResourceDefinition();

  const groupsMap = new Map<string, CrdInfo[]>();

  for (const crd of list.items) {
    const spec = crd.spec;
    if (!spec) continue;
    const group = spec.group;
    const version = preferredVersion(crd);
    if (!version) continue;
    const names = spec.names;
    const scope = spec.scope === 'Cluster' ? 'Cluster' : 'Namespaced';

    const info: CrdInfo = {
      group,
      version,
      kind: names.kind,
      plural: names.plural,
      scope,
      // Rust left short_names empty (Discovery API didn't surface them); the
      // CRD object does expose spec.names.shortNames, so we keep parity with
      // the original wire output by emitting [].
      short_names: [],
    };

    const arr = groupsMap.get(group);
    if (arr) arr.push(info);
    else groupsMap.set(group, [info]);
  }

  const groups: CrdGroup[] = [...groupsMap.entries()].map(([group, resources]) => {
    resources.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
    return { group, resources };
  });
  groups.sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));

  return groups;
}

// ===========================================================================
// Resource projection — mirror meta_from() + the Resource build in listing.rs.
// ===========================================================================

interface RawDynamicObject {
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    resourceVersion?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    creationTimestamp?: string;
    ownerReferences?: unknown[];
  };
  spec?: unknown;
  status?: unknown;
}

/** Mirror meta_from(): map k8s ObjectMeta -> ResourceMetadata (snake_case, null defaults). */
function metaFrom(meta: RawDynamicObject['metadata']): ResourceMetadata {
  const ownerRefs = meta?.ownerReferences;
  return {
    name: meta?.name ?? null,
    namespace: meta?.namespace ?? null,
    uid: meta?.uid ?? null,
    resource_version: meta?.resourceVersion ?? null,
    labels: meta?.labels ?? null,
    annotations: meta?.annotations ?? null,
    creation_timestamp: meta?.creationTimestamp ?? null,
    owner_references: ownerRefs && ownerRefs.length > 0 ? ownerRefs : null,
  };
}

/** Build a Resource from a dynamic object, mirroring listing.rs (spec/status omitted when absent). */
function dynamicToResource(obj: RawDynamicObject, apiVersion: string, kind: string): Resource {
  const res: Resource = {
    api_version: apiVersion,
    kind,
    metadata: metaFrom(obj.metadata),
  };
  if (obj.spec !== undefined) res.spec = obj.spec;
  if (obj.status !== undefined) res.status = obj.status;
  return res;
}

// ===========================================================================
// CRD schema columns — additionalPrinterColumns + heuristic fallback.
// ===========================================================================

interface RawPrinterColumn {
  name?: string;
  jsonPath?: string;
  type?: string;
  description?: string;
}

/** Mirror get_crd_columns(): read additionalPrinterColumns for the version. */
async function getCrdColumns(
  group: string,
  version: string,
  plural: string,
): Promise<CrdColumn[]> {
  const apiext = makeApiClient(ApiextensionsV1Api);
  const crdName = `${plural}.${group}`;

  let crd: V1CustomResourceDefinition;
  try {
    crd = await apiext.readCustomResourceDefinition({ name: crdName });
  } catch {
    return []; // RBAC fallback: can't read CRD def.
  }

  const versions = crd.spec?.versions ?? [];
  const matching = versions.find((v) => v.name === version);
  const printerCols = (matching?.additionalPrinterColumns ?? []) as RawPrinterColumn[];

  const columns: CrdColumn[] = [];
  for (const col of printerCols) {
    const name = col.name;
    const jsonPath = col.jsonPath;
    if (name === undefined || jsonPath === undefined) continue;
    const colType = col.type ?? 'string';
    const description = col.description ?? '';

    if (isSensitiveField(name)) continue;
    if (name === 'Age' && jsonPath.includes('creationTimestamp')) continue;

    columns.push({
      name,
      json_path: jsonPath,
      column_type: colType,
      description,
    });
  }
  return columns;
}

/** Mirror extract_heuristic_columns(): derive columns from .status / .spec of the first item. */
function extractHeuristicColumns(items: Resource[], maxColumns: number): CrdColumn[] {
  if (items.length === 0) return [];

  const sample = items[0];
  const columns: CrdColumn[] = [];

  const sampleStatus =
    sample.status && typeof sample.status === 'object'
      ? (sample.status as Record<string, unknown>)
      : null;
  const sampleSpec =
    sample.spec && typeof sample.spec === 'object'
      ? (sample.spec as Record<string, unknown>)
      : null;

  const priorityPaths: Array<[string, string, 'status' | 'spec']> = [
    ['.status.phase', 'Phase', 'status'],
    ['.status.replicas', 'Replicas', 'status'],
    ['.status.readyReplicas', 'Ready', 'status'],
    ['.status.availableReplicas', 'Available', 'status'],
    ['.status.currentReplicas', 'Current Replicas', 'status'],
    ['.status.desiredReplicas', 'Desired Replicas', 'status'],
    ['.spec.replicas', 'Desired', 'spec'],
    ['.status.observedGeneration', 'Observed Gen', 'status'],
  ];

  for (const [jsonPath, name, root] of priorityPaths) {
    const rootVal = root === 'status' ? sampleStatus : sampleSpec;
    if (rootVal) {
      const field = jsonPath.split('.').pop() ?? '';
      if (
        Object.prototype.hasOwnProperty.call(rootVal, field) &&
        rootVal[field] !== undefined &&
        !isSensitiveField(field)
      ) {
        columns.push({
          name,
          json_path: jsonPath,
          column_type: 'string',
          description: '',
        });
      }
    }
    if (columns.length >= maxColumns) break;
  }

  // Scan top-level .status scalar fields (depth 1) if room remains.
  if (columns.length < maxColumns && sampleStatus) {
    for (const [key, val] of Object.entries(sampleStatus)) {
      if (columns.length >= maxColumns) break;
      if (isSensitiveField(key)) continue;
      // Skip complex objects / arrays — scalars only.
      if (val !== null && typeof val === 'object') continue;
      const path = `.status.${key}`;
      if (columns.some((c) => c.json_path === path)) continue;
      columns.push({
        name: key,
        json_path: path,
        column_type: 'string',
        description: '',
      });
    }
  }

  return columns;
}

// ===========================================================================
// list_crd_resources — list a CRD's objects + smart columns (paged at 500).
// ===========================================================================

interface RawCustomObjectList {
  items?: RawDynamicObject[];
  metadata?: { continue?: string; remainingItemCount?: number };
}

async function listCrdResources(
  group: string,
  version: string,
  kind: string,
  plural: string,
  scope: string,
  namespace: string | undefined,
): Promise<CrdResourceList> {
  const custom = makeApiClient(CustomObjectsApi);
  const apiVersion = group.length === 0 ? version : `${group}/${version}`;

  const useNamespaced = scope !== 'Cluster' && namespace !== undefined && namespace.length > 0;

  const items: Resource[] = [];
  let continueToken: string | undefined;

  for (;;) {
    let list: RawCustomObjectList;
    if (useNamespaced) {
      list = (await custom.listNamespacedCustomObject({
        group,
        version,
        namespace: namespace as string,
        plural,
        limit: 500,
        _continue: continueToken,
      })) as RawCustomObjectList;
    } else {
      list = (await custom.listClusterCustomObject({
        group,
        version,
        plural,
        limit: 500,
        _continue: continueToken,
      })) as RawCustomObjectList;
    }

    for (const obj of list.items ?? []) {
      items.push(dynamicToResource(obj, apiVersion, kind));
    }

    const token = list.metadata?.continue;
    if (token && token.length > 0) {
      continueToken = token;
    } else {
      break;
    }
  }

  // additionalPrinterColumns first; fall back to heuristics.
  let columns: CrdColumn[] = [];
  try {
    const cols = await getCrdColumns(group, version, plural);
    columns = cols.length > 0 ? cols : extractHeuristicColumns(items, 8);
  } catch {
    columns = extractHeuristicColumns(items, 8);
  }

  return { items, columns };
}

// ===========================================================================
// get_crd_counts — count objects per CRD, concurrency-limited (semaphore=20).
// ===========================================================================

const COUNT_CONCURRENCY = 20;

async function countCrd(
  custom: CustomObjectsApi,
  crd: CrdInfo,
  namespace: string | undefined,
): Promise<[string, number]> {
  const useNamespaced =
    crd.scope !== 'Cluster' && namespace !== undefined && namespace.length > 0;

  let count = 0;
  try {
    let list: RawCustomObjectList;
    if (useNamespaced) {
      list = (await custom.listNamespacedCustomObject({
        group: crd.group,
        version: crd.version,
        namespace: namespace as string,
        plural: crd.plural,
        limit: 1,
      })) as RawCustomObjectList;
    } else {
      list = (await custom.listClusterCustomObject({
        group: crd.group,
        version: crd.version,
        plural: crd.plural,
        limit: 1,
      })) as RawCustomObjectList;
    }
    const itemsLen = list.items?.length ?? 0;
    const remaining = list.metadata?.remainingItemCount;
    count = remaining !== undefined && remaining !== null ? remaining + itemsLen : itemsLen;
  } catch {
    count = 0;
  }

  // Key: group/kind for uniqueness (mirror Rust).
  return [`${crd.group}/${crd.kind}`, count];
}

async function getCrdCounts(
  crds: CrdInfo[],
  namespace: string | undefined,
): Promise<Record<string, number>> {
  const custom = makeApiClient(CustomObjectsApi);
  const result: Record<string, number> = {};

  // Bounded-concurrency worker pool (semaphore of 20 in Rust).
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= crds.length) return;
      const [key, count] = await countCrd(custom, crds[i], namespace);
      result[key] = count;
    }
  }

  const workers = Array.from(
    { length: Math.min(COUNT_CONCURRENCY, crds.length) },
    () => worker(),
  );
  await Promise.all(workers);

  return result;
}

// ===========================================================================
// get_crd_conditions — extract .status.conditions (mirror extract_conditions).
// ===========================================================================

function extractConditions(resource: Resource): StatusCondition[] {
  const status =
    resource.status && typeof resource.status === 'object'
      ? (resource.status as Record<string, unknown>)
      : null;
  if (!status) return [];
  const conditions = status.conditions;
  if (!Array.isArray(conditions)) return [];

  const out: StatusCondition[] = [];
  for (const c of conditions) {
    if (c === null || typeof c !== 'object') continue;
    const cond = c as Record<string, unknown>;
    const type = cond.type;
    const condStatus = cond.status;
    if (typeof type !== 'string' || typeof condStatus !== 'string') continue;

    const entry: StatusCondition = { type, status: condStatus };
    if (typeof cond.reason === 'string') entry.reason = cond.reason;
    if (typeof cond.message === 'string') entry.message = cond.message;
    if (typeof cond.lastTransitionTime === 'string') {
      entry.last_transition_time = cond.lastTransitionTime;
    }
    out.push(entry);
  }
  return out;
}

// ===========================================================================
// Argument coercion helpers.
// ===========================================================================

function asOptionalString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  return undefined; // null / undefined / other -> "no value"
}

function requireString(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`Missing or invalid argument: ${field}`);
}

function asCrdInfoArray(value: unknown): CrdInfo[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      group: typeof o.group === 'string' ? o.group : '',
      version: typeof o.version === 'string' ? o.version : '',
      kind: typeof o.kind === 'string' ? o.kind : '',
      plural: typeof o.plural === 'string' ? o.plural : '',
      scope: typeof o.scope === 'string' ? o.scope : 'Namespaced',
      short_names: Array.isArray(o.short_names)
        ? (o.short_names.filter((s) => typeof s === 'string') as string[])
        : [],
    };
  });
}

function asResource(value: unknown): Resource {
  const o = (value ?? {}) as Record<string, unknown>;
  const meta = (o.metadata ?? {}) as Record<string, unknown>;
  const res: Resource = {
    api_version: typeof o.api_version === 'string' ? o.api_version : '',
    kind: typeof o.kind === 'string' ? o.kind : '',
    metadata: {
      name: typeof meta.name === 'string' ? meta.name : null,
      namespace: typeof meta.namespace === 'string' ? meta.namespace : null,
      uid: typeof meta.uid === 'string' ? meta.uid : null,
      resource_version: typeof meta.resource_version === 'string' ? meta.resource_version : null,
      labels: (meta.labels as Record<string, string>) ?? null,
      annotations: (meta.annotations as Record<string, string>) ?? null,
      creation_timestamp:
        typeof meta.creation_timestamp === 'string' ? meta.creation_timestamp : null,
      owner_references: meta.owner_references ?? null,
    },
  };
  if (o.spec !== undefined) res.spec = o.spec;
  if (o.status !== undefined) res.status = o.status;
  if (o.data !== undefined) res.data = o.data;
  if (typeof o.type === 'string') res.type = o.type;
  return res;
}

// ===========================================================================
// Registration.
// ===========================================================================

export function register(handlers: HandlerMap, _ctx: HandlerCtx): void {
  handlers.set('get_security_overview', async (args) => {
    return getSecurityOverview(asOptionalString(args.namespace));
  });

  handlers.set('scan_image', async (args) => {
    return scanSingleImage(requireString(args.image, 'image'));
  });

  handlers.set('discover_crds', async () => {
    return discoverCrds();
  });

  handlers.set('list_crd_resources', async (args) => {
    return listCrdResources(
      requireString(args.group, 'group'),
      requireString(args.version, 'version'),
      requireString(args.kind, 'kind'),
      requireString(args.plural, 'plural'),
      requireString(args.scope, 'scope'),
      asOptionalString(args.namespace),
    );
  });

  handlers.set('get_crd_counts', async (args) => {
    return getCrdCounts(asCrdInfoArray(args.crds), asOptionalString(args.namespace));
  });

  handlers.set('get_crd_conditions', async (args) => {
    return extractConditions(asResource(args.resource));
  });
}
