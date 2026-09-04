// Security handler group — scanner detection, per-pod posture, image scans.
//
// Commands implemented:
//   - get_security_overview  (args: { namespace?: string | null })
//   - scan_image             (args: { image: string })
//
// Wire-casing notes (frontend is source of truth):
//   - get_security_overview: AsyncLoadStore._load sends { namespace } (string | null).
//   - scan_image: arg key `image`.
// Result shapes are snake_case on the wire.

import { spawn } from 'node:child_process';

import type { V1Pod } from '@kubernetes/client-node';

import type { HandlerCtx, HandlerMap } from '../dispatch';
import { getCoreV1Api } from '../k8s/client';

// ===========================================================================
// Result types — snake_case wire casing.
// ===========================================================================

/** Vulnerability counts by severity. */
interface VulnerabilityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  unknown: number;
}

/** `failed` carries empty counts: zero findings because nothing was looked
 *  at, which the UI must not present as "no vulnerabilities". */
export type ImageScanStatus = 'scanned' | 'failed';

export interface ImageScanResult {
  image: string;
  vulns: VulnerabilityCounts;
  scanned_at: string;
  status: ImageScanStatus;
  /** Scanner stderr for a failed scan, trimmed to one line. */
  error?: string;
}

export interface PodSecurityInfo {
  name: string;
  namespace: string;
  /** Scan results, successful or failed, for the pod's images. */
  images: ImageScanResult[];
  /** Images with no result at all — no scanner installed, or not scanned yet. */
  unscanned_images: string[];
  total_vulns: VulnerabilityCounts;
  compliant: boolean;
}

interface SecurityOverview {
  pods: PodSecurityInfo[];
  total_vulns: VulnerabilityCounts;
  total_images_scanned: number;
  compliant_pods: number;
  non_compliant_pods: number;
  scanner: string; // "trivy" | "grype" | "none"
  fetched_at: string;
}

// ===========================================================================
// Scanner detection + image scanning (trivy / grype shell-outs).
// ===========================================================================

type Scanner = 'trivy' | 'grype' | 'none';

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError: boolean;
  timedOut: boolean;
}

/** Default kill-switch for scanner shell-outs (grype has no --timeout flag). */
const RUN_COMMAND_TIMEOUT_MS = 120_000; // 120s

/** Run a binary, capturing stdout/stderr/exit. Never rejects. Kills the
 *  process if it exceeds `timeoutMs` (default 120s). */
function runCommand(
  cmd: string,
  args: string[],
  timeoutMs: number = RUN_COMMAND_TIMEOUT_MS,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ code: null, stdout: '', stderr: '', spawnError: true, timedOut: false });
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({
        code: null,
        stdout,
        stderr: stderr || `${cmd} timed out after ${Math.round(timeoutMs / 1000)}s`,
        spawnError: false,
        timedOut: true,
      });
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, spawnError: true, timedOut: false });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, spawnError: false, timedOut: false });
    });
  });
}

// Scanner-detection cache — probing `trivy --version` / `grype version` on
// every call is wasteful; a long TTL still picks up new installs without a
// restart.
const SCANNER_CACHE_TTL_MS = 600_000; // 10 min

let scannerCache: { scanner: Scanner; expiresAt: number } | null = null;

/** Probe `trivy --version`, then `grype version`. The result is cached for
 *  SCANNER_CACHE_TTL_MS. */
async function detectScanner(): Promise<Scanner> {
  if (scannerCache && scannerCache.expiresAt > Date.now()) {
    return scannerCache.scanner;
  }
  let scanner: Scanner = 'none';
  const trivy = await runCommand('trivy', ['--version']);
  if (!trivy.spawnError && trivy.code === 0) {
    scanner = 'trivy';
  } else {
    const grype = await runCommand('grype', ['version']);
    if (!grype.spawnError && grype.code === 0) {
      scanner = 'grype';
    }
  }
  scannerCache = { scanner, expiresAt: Date.now() + SCANNER_CACHE_TTL_MS };
  return scanner;
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
// Scan cache — process-global, per-image TTL (a scan of one image stays fresh
// for IMAGE_CACHE_TTL_MS independently of when other images were scanned).
// ---------------------------------------------------------------------------

const IMAGE_CACHE_TTL_MS = 1_800_000; // 30 min per scanned image
const IMAGE_CACHE_MAX_ENTRIES = 512;
const SCAN_CONCURRENCY = 4;

interface CachedScan {
  result: ImageScanResult;
  expiresAt: number; // epoch ms
}

const scanCache = new Map<string, CachedScan>();

function getCachedScan(image: string): ImageScanResult | undefined {
  const entry = scanCache.get(image);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    scanCache.delete(image);
    return undefined;
  }
  return entry.result;
}

function putCachedScan(result: ImageScanResult): void {
  // Refresh insertion order so eviction drops the least-recently-written key.
  scanCache.delete(result.image);
  scanCache.set(result.image, { result, expiresAt: Date.now() + IMAGE_CACHE_TTL_MS });
  // Bound the cache: drop expired entries first, then oldest until under cap.
  if (scanCache.size > IMAGE_CACHE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [key, entry] of scanCache) {
      if (entry.expiresAt <= now) scanCache.delete(key);
    }
    for (const key of scanCache.keys()) {
      if (scanCache.size <= IMAGE_CACHE_MAX_ENTRIES) break;
      scanCache.delete(key);
    }
  }
}

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

  // Reuse per-image cached scans that are still fresh.
  for (const img of uniqueImages) {
    const cached = getCachedScan(img);
    if (cached) imageResults.set(img, cached);
  }

  // Scan images not in cache with a bounded-concurrency worker pool.
  if (scanner !== 'none') {
    const pending = uniqueImages.filter((img) => !imageResults.has(img));
    let cursor = 0;
    async function worker(): Promise<void> {
      for (;;) {
        const i = cursor++;
        if (i >= pending.length) return;
        const img = pending[i];
        let result: ImageScanResult;
        try {
          const vulns = await scanImage(scanner, img);
          result = { image: img, vulns, scanned_at: now, status: 'scanned' };
        } catch (err) {
          // A failed scan is recorded as such, not as a clean image.
          const message = err instanceof Error ? err.message : String(err);
          result = {
            image: img,
            vulns: emptyCounts(),
            scanned_at: now,
            status: 'failed',
            error: message.split('\n')[0].slice(0, 300),
          };
        }
        imageResults.set(img, result);
        putCachedScan(result);
      }
    }
    const workers = Array.from(
      { length: Math.min(SCAN_CONCURRENCY, pending.length) },
      () => worker(),
    );
    await Promise.all(workers);
  }

  return {
    ...summarizePods(podImages, imageResults),
    scanner,
    fetched_at: now,
  };
}

/**
 * Fold per-image scan results into per-pod posture. Pure, so the "not
 * scanned" bookkeeping is testable without a scanner: an image with no result
 * lands in `unscanned_images`, a failed one keeps its `failed` status, and
 * only successful scans count toward `total_images_scanned`.
 */
export function summarizePods(
  podImages: ReadonlyArray<readonly [string, string, readonly string[]]>,
  imageResults: ReadonlyMap<string, ImageScanResult>,
): Omit<SecurityOverview, 'scanner' | 'fetched_at'> {
  const pods: PodSecurityInfo[] = [];
  const overallVulns = emptyCounts();
  let compliantCount = 0;
  let nonCompliantCount = 0;

  for (const [podName, podNs, images] of podImages) {
    const podVulns = emptyCounts();
    const podImagesResults: ImageScanResult[] = [];
    const unscanned: string[] = [];
    for (const img of images) {
      const result = imageResults.get(img);
      if (result) {
        mergeCounts(podVulns, result.vulns);
        podImagesResults.push(result);
      } else {
        unscanned.push(img);
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
      unscanned_images: unscanned,
      total_vulns: podVulns,
      compliant,
    });
  }

  // Sort: non-compliant first, then by critical desc, then high desc.
  // `compliant` sorts ascending (false < true), so non-compliant lands first.
  pods.sort((a, b) => {
    const byCompliant = Number(a.compliant) - Number(b.compliant);
    if (byCompliant !== 0) return byCompliant;
    const byCritical = b.total_vulns.critical - a.total_vulns.critical;
    if (byCritical !== 0) return byCritical;
    return b.total_vulns.high - a.total_vulns.high;
  });

  let scanned = 0;
  for (const result of imageResults.values()) {
    if (result.status === 'scanned') scanned += 1;
  }

  return {
    pods,
    total_vulns: overallVulns,
    total_images_scanned: scanned,
    compliant_pods: compliantCount,
    non_compliant_pods: nonCompliantCount,
  };
}

async function scanSingleImage(image: string): Promise<ImageScanResult> {
  const scanner = await detectScanner();
  if (scanner === 'none') {
    throw new Error('No vulnerability scanner found. Install trivy or grype.');
  }
  const vulns = await scanImage(scanner, image);
  return { image, vulns, scanned_at: new Date().toISOString(), status: 'scanned' };
}

// ===========================================================================
// Argument coercion + registration.
// ===========================================================================

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function requireString(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`Missing or invalid argument: ${field}`);
}

export function register(handlers: HandlerMap, _ctx: HandlerCtx): void {
  handlers.set('get_security_overview', async (args) => {
    return getSecurityOverview(asOptionalString(args.namespace));
  });

  handlers.set('scan_image', async (args) => {
    return scanSingleImage(requireString(args.image, 'image'));
  });
}
