// Handler module: helm (read-only)
//
// Commands:
//   list_helm_releases        -> latest revision of every release, per namespace
//   get_helm_release          -> one revision in full (values, manifest, notes)
//   list_helm_release_history -> every stored revision of a release
//
// Helm 3 keeps its state in the cluster, not in a local database: one Secret
// per release revision, named `sh.helm.release.v1.<release>.v<revision>`, typed
// `helm.sh/release.v1`, carrying labels name/owner/status/version. The payload
// is base64(gzip(release-json)) — and the API base64s Secret data on top of
// that, so decoding is: base64 -> base64 -> gunzip -> JSON.
//
// Reading those Secrets directly is what `helm list` does, so this needs no
// helm binary and no extra RBAC beyond "get secrets" in the namespace. Nothing
// here writes: install/upgrade/rollback stay out of scope.

import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';

// Async gunzip: release payloads carry the full rendered manifest (often MBs);
// gunzipSync would block the main-process event loop once per release.
const gunzipAsync = promisify(gunzip);

import { getCoreV1Api } from '../k8s/client.js';
import { apiGet, META_ACCEPT } from '../k8s/api.js';
import { k8sErrorMessage } from '../k8s/errors.js';
import { mapWithConcurrency } from '../util/concurrency.js';
import type { HandlerMap } from '../dispatch.js';

const HELM_OWNER_SELECTOR = 'owner=helm';
const HELM_SECRET_TYPE = 'helm.sh/release.v1';
const GZIP_MAGIC = [0x1f, 0x8b];

// ---------------------------------------------------------------------------
// Wire shapes (snake_case; mirror in src/lib/types/helm.ts)
// ---------------------------------------------------------------------------

export interface HelmRelease {
  name: string;
  namespace: string;
  revision: number;
  status: string;
  chart: string;
  chart_version: string;
  app_version: string;
  /** RFC3339 timestamp of this revision's deploy. */
  updated: string;
  description: string;
}

export interface HelmReleaseDetail extends HelmRelease {
  /** Values the user supplied (helm get values). */
  values: Record<string, unknown>;
  /** The chart's default values (helm show values). */
  chart_values: Record<string, unknown>;
  /** Rendered manifest (helm get manifest). */
  manifest: string;
  /** NOTES.txt as rendered at install time (helm get notes). */
  notes: string;
}

// ---------------------------------------------------------------------------
// Release payload decoding
// ---------------------------------------------------------------------------

interface RawRelease {
  name?: string;
  namespace?: string;
  version?: number;
  info?: {
    status?: string;
    description?: string;
    last_deployed?: string;
    first_deployed?: string;
    notes?: string;
  };
  chart?: {
    metadata?: { name?: string; version?: string; appVersion?: string };
    values?: Record<string, unknown>;
  };
  config?: Record<string, unknown>;
  manifest?: string;
}

/**
 * Decode a Secret's `release` field into the Helm release object.
 *
 * Exported for the tests: this is the one piece of real logic in the module and
 * the double-base64 is exactly the part that silently breaks.
 */
export async function decodeRelease(data: string): Promise<RawRelease> {
  // Layer 1: the Kubernetes API's own base64 of the Secret value.
  let buf = Buffer.from(data, 'base64');
  // Layer 2: helm's base64, present unless something already unwrapped it.
  if (!(buf[0] === GZIP_MAGIC[0] && buf[1] === GZIP_MAGIC[1])) {
    buf = Buffer.from(buf.toString('utf8'), 'base64');
  }
  // Layer 3: gzip, which helm has used for every release since v3.
  const json =
    buf[0] === GZIP_MAGIC[0] && buf[1] === GZIP_MAGIC[1]
      ? (await gunzipAsync(buf)).toString('utf8')
      : buf.toString('utf8');

  const parsed = JSON.parse(json) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Helm release payload is not a JSON object');
  }
  return parsed as RawRelease;
}

/** Project a decoded release onto the list row shape. */
export function releaseSummary(r: RawRelease): HelmRelease {
  const meta = r.chart?.metadata ?? {};
  return {
    name: r.name ?? '',
    namespace: r.namespace ?? '',
    revision: r.version ?? 0,
    status: r.info?.status ?? 'unknown',
    chart: meta.name ?? '',
    chart_version: meta.version ?? '',
    app_version: meta.appVersion ?? '',
    updated: r.info?.last_deployed ?? '',
    description: r.info?.description ?? '',
  };
}

function releaseDetail(r: RawRelease): HelmReleaseDetail {
  return {
    ...releaseSummary(r),
    values: r.config ?? {},
    chart_values: r.chart?.values ?? {},
    manifest: r.manifest ?? '',
    notes: r.info?.notes ?? '',
  };
}

// ---------------------------------------------------------------------------
// Secret lookup
// ---------------------------------------------------------------------------

interface SecretMeta {
  name: string;
  namespace: string;
  release: string;
  revision: number;
}

function optNamespace(args: Record<string, unknown>): string | undefined {
  const v = args.namespace;
  if (typeof v !== 'string' || v === '' || v === 'All Namespaces') return undefined;
  return v;
}

function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v === '') throw new Error(`Missing or invalid '${key}' argument`);
  return v;
}

interface SecretMetaList {
  items?: Array<{ metadata?: { name?: string; namespace?: string; labels?: Record<string, string> } }>;
}

/**
 * List the release Secrets' METADATA only — helm's own labels carry the release
 * name and revision, so the index is built without pulling a single release
 * payload. That matters: a cluster with a handful of charts still has dozens of
 * revision Secrets, each holding a gzipped copy of the whole rendered release,
 * and the caller only decodes the revisions it actually shows.
 */
async function listReleaseSecrets(
  namespace: string | undefined,
  releaseName?: string,
): Promise<SecretMeta[]> {
  const path =
    namespace !== undefined
      ? `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets`
      : '/api/v1/secrets';
  const query = {
    labelSelector: releaseName
      ? `${HELM_OWNER_SELECTOR},name=${releaseName}`
      : HELM_OWNER_SELECTOR,
    fieldSelector: `type=${HELM_SECRET_TYPE}`,
  };

  try {
    const list = await apiGet<SecretMetaList>(path, query, META_ACCEPT);
    return secretMetasFrom(list);
  } catch (err) {
    throw new Error(k8sErrorMessage(err));
  }
}

/** Keep only the Secrets whose helm labels name a release and a revision. */
export function secretMetasFrom(list: SecretMetaList): SecretMeta[] {
  const out: SecretMeta[] = [];
  for (const secret of list.items ?? []) {
    const labels = secret.metadata?.labels ?? {};
    const release = labels['name'];
    const revision = Number.parseInt(labels['version'] ?? '', 10);
    if (!release || Number.isNaN(revision)) continue;
    out.push({
      name: secret.metadata?.name ?? '',
      namespace: secret.metadata?.namespace ?? '',
      release,
      revision,
    });
  }
  return out;
}

/** Fetch and decode one release Secret. */
async function readRelease(namespace: string, secretName: string): Promise<RawRelease> {
  const core = getCoreV1Api();
  try {
    const secret = await core.readNamespacedSecret({ name: secretName, namespace });
    const payload = (secret.data ?? {})['release'];
    if (typeof payload !== 'string') {
      throw new Error(`Secret ${namespace}/${secretName} has no 'release' payload`);
    }
    return decodeRelease(payload);
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : k8sErrorMessage(err));
  }
}

/** Keep only the newest revision per (namespace, release). */
export function latestPerRelease(secrets: SecretMeta[]): SecretMeta[] {
  const best = new Map<string, SecretMeta>();
  for (const s of secrets) {
    const key = `${s.namespace}/${s.release}`;
    const current = best.get(key);
    if (!current || s.revision > current.revision) best.set(key, s);
  }
  return [...best.values()];
}

/** Cap on simultaneous release-secret reads: N releases used to mean N
 * parallel requests + N decompressions all at once. */
const READ_RELEASE_CONCURRENCY = 8;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function listHelmReleases(args: Record<string, unknown>): Promise<HelmRelease[]> {
  const namespace = optNamespace(args);
  const latest = latestPerRelease(await listReleaseSecrets(namespace));

  const releases = await mapWithConcurrency(latest, READ_RELEASE_CONCURRENCY, async (s) => {
    try {
      return releaseSummary(await readRelease(s.namespace, s.name));
    } catch {
      // A single unreadable/corrupt release must not blank the whole list.
      return null;
    }
  });

  return releases
    .filter((r): r is HelmRelease => r !== null)
    .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
}

async function getHelmRelease(args: Record<string, unknown>): Promise<HelmReleaseDetail> {
  const name = reqStr(args, 'name');
  const namespace = reqStr(args, 'namespace');
  const revision = typeof args.revision === 'number' ? args.revision : undefined;

  const secrets = await listReleaseSecrets(namespace, name);
  const target =
    revision === undefined
      ? latestPerRelease(secrets)[0]
      : secrets.find((s) => s.revision === revision);
  if (!target) {
    throw new Error(`Helm release "${name}" not found in namespace "${namespace}"`);
  }
  return releaseDetail(await readRelease(target.namespace, target.name));
}

async function listHelmReleaseHistory(args: Record<string, unknown>): Promise<HelmRelease[]> {
  const name = reqStr(args, 'name');
  const namespace = reqStr(args, 'namespace');

  const secrets = await listReleaseSecrets(namespace, name);
  const revisions = await mapWithConcurrency(secrets, READ_RELEASE_CONCURRENCY, async (s) => {
    try {
      return releaseSummary(await readRelease(s.namespace, s.name));
    } catch {
      return null;
    }
  });

  return revisions
    .filter((r): r is HelmRelease => r !== null)
    .sort((a, b) => b.revision - a.revision);
}

export function register(handlers: HandlerMap): void {
  handlers.set('list_helm_releases', async (args) => listHelmReleases(args));
  handlers.set('get_helm_release', async (args) => getHelmRelease(args));
  handlers.set('list_helm_release_history', async (args) => listHelmReleaseHistory(args));
}
