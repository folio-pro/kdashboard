// Handler module: openapi
//
// Commands:
//   get_openapi_schema -> the OpenAPI v3 schema closure for one kind, used by
//                         the YAML editor for autocompletion and validation
//
// WHY THIS EXISTS: the editor previously autocompleted from a hand-written
// table covering 12 kinds. The cluster already publishes an exact, version-
// correct schema for every kind it serves — including CRDs — at /openapi/v3,
// so we read that instead of maintaining a copy that silently rots.
//
// Three properties make this safe to sit in front of an editor:
//
//   * It never throws for the expected failures. A cluster on Kubernetes < 1.23
//     has no /openapi/v3, and a restricted ServiceAccount may be denied it. Both
//     return { available: false } so the renderer falls back to the static
//     schema instead of showing the user an error they cannot act on. This
//     mirrors get_pod_metrics, which reports `available: false` when there is no
//     metrics-server.
//   * It prunes before it answers. The apps/v1 group document is ~1.5 MB; the
//     transitive closure of a single kind is a fraction of that, and pruning on
//     this side keeps it off the IPC channel.
//   * It caches the group document both in memory and under userData, keyed by
//     the apiserver's gitVersion, so upgrading a cluster invalidates the cache
//     without anyone having to remember to.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import nodePath from 'node:path';

import { app } from 'electron';

import { getApiserverOrigin, kc, onConfigChange } from '../k8s/client.js';
import {
  findRootSchema,
  openApiPathFor,
  pruneClosure,
  type GroupDocument,
  type OpenApiSchemaResult,
} from '../k8s/openapi-schema.js';
import type { HandlerMap } from '../dispatch.js';

// Wire shapes and the pure lookup helpers live in k8s/openapi-schema.ts so they
// stay testable outside Electron. The renderer mirror is
// src/lib/utils/openapi-schema.ts.
export type { OpenApiSchema, OpenApiSchemaResult } from '../k8s/openapi-schema.js';

const EMPTY: OpenApiSchemaResult = { available: false, root: null, schemas: {}, reason: null };

/** Requests to the apiserver are bounded; a hung control plane must not wedge
 *  the editor, which merely degrades to the static schema. */
const FETCH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Authenticated fetch against the apiserver
// ---------------------------------------------------------------------------

/**
 * Flatten whatever header representation client-node hands back — a plain
 * object, an entries array, or a Headers instance — into a string map.
 */
function normalizeHeaders(raw: unknown): Record<string, string> {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    return Object.fromEntries(raw.map((pair) => [String(pair[0]), String(pair[1])]));
  }
  if (typeof (raw as Headers).forEach === 'function' && typeof raw === 'object') {
    const out: Record<string, string> = {};
    (raw as Headers).forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (typeof raw === 'object') {
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
    );
  }
  return {};
}

/**
 * GET a JSON document from the active apiserver.
 *
 * TLS (custom CA, mTLS, skipTLSVerify) is already applied by the global undici
 * dispatcher installed in k8s/client.ts, which scopes those options to the
 * apiserver origin. What that dispatcher cannot supply is the Authorization
 * header for token/exec auth, so applyToFetchOptions fills it in here.
 *
 * Returns null for any non-200 — callers treat "no schema" as a normal state.
 */
async function fetchApiserverJson<T>(
  path: string,
): Promise<{ body: T | null; reason: string | null }> {
  const origin = getApiserverOrigin();
  if (!origin) return { body: null, reason: 'no active cluster' };

  let headers: Record<string, string>;
  try {
    // applyToFetchOptions is typed against node-fetch, whose RequestInit is not
    // assignable to undici's. Only the auth headers are wanted here, so take
    // those and leave the rest of the init to the global fetch.
    const applied = (await kc().applyToFetchOptions({})) as { headers?: unknown };
    headers = normalizeHeaders(applied.headers);
  } catch (err) {
    return { body: null, reason: `auth setup failed: ${(err as Error).message}` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(`${origin}/${path}`, { headers, signal: controller.signal });
    if (!resp.ok) {
      return { body: null, reason: `apiserver returned ${resp.status} for /${path}` };
    }
    return { body: (await resp.json()) as T, reason: null };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { body: null, reason: `/${path} timed out after ${FETCH_TIMEOUT_MS / 1000}s` };
    }
    return { body: null, reason: `/${path} failed: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Cache — memory for the session, disk across restarts, keyed by gitVersion
// ---------------------------------------------------------------------------

/** Stable, non-identifying cache directory name for the current apiserver. */
function originKey(): string {
  const origin = getApiserverOrigin() ?? 'unknown';
  return createHash('sha256').update(origin).digest('hex').slice(0, 16);
}

function cacheDir(): string {
  let base: string;
  try {
    base = app.getPath('userData');
  } catch {
    // `app` is unavailable outside Electron (unit tests); fall back to a temp
    // directory so the cache layer stays exercisable.
    base = nodePath.join(process.cwd(), '.cache');
  }
  return nodePath.join(base, 'openapi-cache', originKey());
}

let tempCounter = 0;

async function atomicWrite(target: string, contents: string): Promise<void> {
  await fs.mkdir(nodePath.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${tempCounter++}`;
  try {
    await fs.writeFile(tmp, contents);
    await fs.rename(tmp, target);
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

/** Cached apiserver gitVersion for this session; the disk cache key. */
let gitVersionCache: string | null = null;

async function apiserverVersion(): Promise<string> {
  if (gitVersionCache) return gitVersionCache;
  const { body } = await fetchApiserverJson<{ gitVersion?: string }>('version');
  gitVersionCache = body?.gitVersion ?? 'unknown';
  return gitVersionCache;
}

/** In-memory group documents, keyed by the /openapi/v3 sub-path. */
const memoryCache = new Map<string, GroupDocument>();

function diskPathFor(gvPath: string): string {
  return nodePath.join(cacheDir(), `${gvPath.replace(/\//g, '_')}.json`);
}

async function readDiskCache(gvPath: string, version: string): Promise<GroupDocument | null> {
  try {
    const metaRaw = await fs.readFile(nodePath.join(cacheDir(), 'meta.json'), 'utf8');
    const meta = JSON.parse(metaRaw) as { gitVersion?: string };
    // A cluster upgrade changes the schemas; stale entries are simply ignored
    // and overwritten on the next fetch.
    if (meta.gitVersion !== version) return null;
    const raw = await fs.readFile(diskPathFor(gvPath), 'utf8');
    return JSON.parse(raw) as GroupDocument;
  } catch {
    return null;
  }
}

async function writeDiskCache(gvPath: string, version: string, doc: GroupDocument): Promise<void> {
  try {
    await atomicWrite(
      nodePath.join(cacheDir(), 'meta.json'),
      JSON.stringify({ gitVersion: version, cachedAt: new Date().toISOString() }),
    );
    await atomicWrite(diskPathFor(gvPath), JSON.stringify(doc));
  } catch {
    // A read-only or full disk must not break autocompletion.
  }
}

/**
 * Bumped by resetOpenApiCache. A request captures it before going to the
 * network and re-checks it before writing, so a response that was already in
 * flight when the user switched context cannot be stored against the new
 * cluster — emptying the caches alone does not stop that write.
 */
let cacheGeneration = 0;

/** In-flight fetches keyed by gvPath, so two editors opening the same kind at
 *  once do not each pull the ~1.5 MB group document. */
const inFlight = new Map<string, Promise<{ doc: GroupDocument | null; reason: string | null }>>();

/** Fetch one API group's OpenAPI document, consulting both cache layers. */
async function loadGroupDocument(
  gvPath: string,
): Promise<{ doc: GroupDocument | null; reason: string | null }> {
  const cached = memoryCache.get(gvPath);
  if (cached) return { doc: cached, reason: null };

  const pending = inFlight.get(gvPath);
  if (pending) return pending;

  const request = fetchGroupDocument(gvPath).finally(() => {
    inFlight.delete(gvPath);
  });
  inFlight.set(gvPath, request);
  return request;
}

async function fetchGroupDocument(
  gvPath: string,
): Promise<{ doc: GroupDocument | null; reason: string | null }> {
  const generation = cacheGeneration;
  const version = await apiserverVersion();

  const fromDisk = await readDiskCache(gvPath, version);
  if (fromDisk) {
    if (generation === cacheGeneration) memoryCache.set(gvPath, fromDisk);
    return { doc: fromDisk, reason: null };
  }

  const { body, reason } = await fetchApiserverJson<GroupDocument>(`openapi/v3/${gvPath}`);
  if (!body) return { doc: null, reason };

  // The context changed while this was in flight: the document describes the
  // previous apiserver, so answer this caller but do not cache it.
  if (generation !== cacheGeneration) {
    return { doc: body, reason: null };
  }

  memoryCache.set(gvPath, body);
  await writeDiskCache(gvPath, version, body);
  return { doc: body, reason: null };
}

// ---------------------------------------------------------------------------
// Command implementation
// ---------------------------------------------------------------------------

async function getOpenApiSchema(args: Record<string, unknown>): Promise<OpenApiSchemaResult> {
  const apiVersion = typeof args.apiVersion === 'string' ? args.apiVersion : '';
  const kind = typeof args.kind === 'string' ? args.kind : '';
  if (apiVersion === '' || kind === '') {
    return { ...EMPTY, reason: 'apiVersion and kind are required' };
  }

  const gvPath = openApiPathFor(apiVersion);
  if (!gvPath) return { ...EMPTY, reason: `unrecognized apiVersion '${apiVersion}'` };

  const { doc, reason } = await loadGroupDocument(gvPath);
  const schemas = doc?.components?.schemas;
  if (!schemas) return { ...EMPTY, reason: reason ?? 'group document has no schemas' };

  const root = findRootSchema(schemas, apiVersion, kind);
  if (!root) return { ...EMPTY, reason: `no schema for ${apiVersion} ${kind}` };

  return { available: true, root, schemas: pruneClosure(schemas, root), reason: null };
}

/** Drop every cached document. Exported for tests. */
export function resetOpenApiCache(): void {
  memoryCache.clear();
  gitVersionCache = null;
  // Invalidates any request already in flight, which would otherwise write the
  // old cluster's document into the freshly cleared cache when it resolves.
  cacheGeneration++;
}

// Switching context points at a different apiserver with its own version and
// its own CRDs, so every in-memory document must go. The on-disk cache is keyed
// by origin hash and survives, which is the point of keying it that way.
onConfigChange(resetOpenApiCache);

export function register(handlers: HandlerMap): void {
  handlers.set('get_openapi_schema', async (args) => getOpenApiSchema(args));
}
