// Security handler group — ports the Tauri "security" commands to
// @kubernetes/client-node.
//
// Rust sources ported (faithful 1:1):
//   - src-tauri/src/k8s/security.rs
//       get_security_overview (scanner detection + per-pod posture) and
//       scan_single_image (single-image scan)
//   - src-tauri/src/commands/k8s_commands.rs (the #[tauri::command] wrappers)
//
// Commands implemented (EXACT Tauri command strings):
//   - get_security_overview  (args: { namespace?: string | null })
//   - scan_image             (args: { image: string })
//
// Wire-casing notes (frontend is source of truth):
//   - get_security_overview: AsyncLoadStore._load sends { namespace } (string | null).
//   - scan_image: arg key `image` (Rust param `image`).
// Result SHAPES mirror serde wire-casing in src-tauri/src/k8s/security.rs.

import { spawn } from 'node:child_process';

import type { V1Pod } from '@kubernetes/client-node';

import type { HandlerCtx, HandlerMap } from '../dispatch';
import { getCoreV1Api } from '../k8s/client';

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

// ===========================================================================
// Scanner detection + image scanning (trivy / grype shell-outs).
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
