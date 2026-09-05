// Shared @kubernetes/client-node configuration + typed Api factory helpers.
//
// Every k8s handler MUST go through these helpers rather than constructing its
// own KubeConfig — this keeps a single source of truth for the active context
// and the optional kubeconfig path override coming from settings.
//
// Behaviour:
//   - load from default kubeconfig (KUBECONFIG env / ~/.kube/config)
//   - honor a kubeconfigPath override persisted in settings
//   - allow switching the active context at runtime (switch_context)

import * as fs from 'node:fs';
import * as https from 'node:https';
import * as tls from 'node:tls';

import { Agent, setGlobalDispatcher, type Dispatcher } from 'undici';

import {
  KubeConfig,
  createConfiguration,
  ServerConfiguration,
  type Configuration,
  type RequestContext,
  CoreV1Api,
  AppsV1Api,
  CustomObjectsApi,
  ApiextensionsV1Api,
  AuthorizationV1Api,
  BatchV1Api,
  NetworkingV1Api,
  RbacAuthorizationV1Api,
  VersionApi,
  type ApiType,
  type ApiConstructor,
} from '@kubernetes/client-node';

/** Optional override path; when set, the config loads from this file instead of default. */
let kubeconfigPathOverride: string | null = null;

/** Optional active context override (set by switch_context). */
let activeContextOverride: string | null = null;

/** Lazily-built, cached KubeConfig. Invalidated when the path/context changes. */
let cachedConfig: KubeConfig | null = null;

/**
 * Listeners fired whenever the cached config is invalidated (kubeconfig path or
 * active-context change). Handlers use this to drop per-cluster caches (e.g.
 * cost.ts node/overview caches) so a context switch never serves stale data.
 */
const configChangeListeners = new Set<() => void>();

/** Register a callback invoked on every kubeconfig path / context change. */
export function onConfigChange(listener: () => void): void {
  configChangeListeners.add(listener);
}

/** Drop every cached config (path/context change, or the file changed on disk). */
export function invalidateConfig(): void {
  cachedConfig = null;
  peerConfigs.clear();
  for (const listener of configChangeListeners) {
    try {
      listener();
    } catch {
      // a broken listener must not break context switching
    }
  }
}

/**
 * Set (or clear) the kubeconfig file path override. Pass null to fall back to
 * the default loader. Invalidates the cached config so the next kc() reloads.
 */
export function setKubeconfigPath(path: string | null): void {
  kubeconfigPathOverride = path && path.trim().length > 0 ? path : null;
  invalidateConfig();
}

/** Current kubeconfig path override, or null if using the default loader. */
export function getKubeconfigPath(): string | null {
  return kubeconfigPathOverride;
}

/**
 * Switch the active context used for subsequent Api calls. Throws if the
 * context does not exist in the loaded config. Invalidates the cache.
 */
export function setActiveContext(contextName: string): void {
  const cfg = buildConfig();
  const ctx = cfg.getContexts().find((c) => c.name === contextName);
  if (!ctx) {
    throw new Error(`Context not found: ${contextName}`);
  }
  activeContextOverride = contextName;
  invalidateConfig();
}

/** Name of the context that will be used for Api calls. */
export function getActiveContextName(): string | undefined {
  return kc().getCurrentContext();
}

function buildConfig(): KubeConfig {
  const cfg = new KubeConfig();
  if (kubeconfigPathOverride) {
    cfg.loadFromFile(kubeconfigPathOverride);
  } else {
    cfg.loadFromDefault();
  }
  if (activeContextOverride) {
    cfg.setCurrentContext(activeContextOverride);
  }
  return cfg;
}

/**
 * Configs for contexts that are NOT active, built on demand for one-off reads
 * (compare a resource across contexts). Dropped with the active config on any
 * path/context change. These deliberately do not touch the TLS dispatcher:
 * callers use the typed client-node Api classes, which carry their own TLS
 * agent, never the raw `apiGet` path that depends on the global dispatcher.
 */
const peerConfigs = new Map<string, KubeConfig>();

/**
 * KubeConfig for `contextName`: the shared active config when it is the active
 * context, else a cached peer config. Throws when the context does not exist.
 */
export function kcFor(contextName: string): KubeConfig {
  if (activeContextOverride === contextName || (cachedConfig && cachedConfig.getCurrentContext() === contextName)) return kc();
  let cfg = peerConfigs.get(contextName);
  if (cfg) return cfg;
  // buildConfig (not kc()) so the peer path never installs the TLS dispatcher
  // for a cluster that is not active.
  cfg = buildConfig();
  if (cfg.getCurrentContext() === contextName) return kc();
  if (!cfg.getContexts().some((c) => c.name === contextName)) {
    throw new Error(`Context not found: ${contextName}`);
  }
  cfg.setCurrentContext(contextName);
  peerConfigs.set(contextName, cfg);
  return cfg;
}

/**
 * Shared KubeConfig honoring the path + active-context overrides. Cached until
 * an override changes. USE THIS — do not `new KubeConfig()` in handlers.
 */
export function kc(): KubeConfig {
  if (!cachedConfig) {
    cachedConfig = buildConfig();
    installTlsDispatcher(cachedConfig);
  }
  return cachedConfig;
}

/** Decode a kubeconfig CA/cert/key field: base64 `*Data` first, else read the file. */
function pemFromDataOrFile(data?: string, file?: string): string | undefined {
  if (data && data.length > 0) {
    // kubeconfig *-data fields are base64-encoded PEM.
    return Buffer.from(data, 'base64').toString('utf8');
  }
  if (file && file.length > 0) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** undici Agent carrying the active cluster's TLS options. Closed on rebuild. */
let clusterAgent: Agent | null = null;

/** Origin (`https://host:port`) of the active apiserver, or null when none. */
let apiserverOrigin: string | null = null;

/** Origin of the active apiserver, for error messages. Null before first use. */
export function getApiserverOrigin(): string | null {
  return apiserverOrigin;
}

/** True once the composed global dispatcher has been installed. */
let dispatcherInstalled = false;

/** Normalize a request/cluster origin for comparison; null when unparseable. */
function originOf(value: string | URL | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(String(value)).origin;
  } catch {
    return null;
  }
}

/**
 * Install a global undici dispatcher that applies the active cluster's TLS
 * options (custom CA, mTLS client cert/key, skipTLSVerify) ONLY to requests
 * whose origin is the apiserver itself; every other origin (pricing CDN,
 * update checks, ...) keeps the default undici Agent with system roots.
 *
 * WHY THIS EXISTS: the @kubernetes/client-node 1.x generated Api classes do
 * their own TLS — they call node-fetch with an `https.Agent` built from the
 * kubeconfig (see node_modules/.../dist/config.js:157 and gen/http/http.js
 * setAgent) — but our raw REST path (resources.ts apiGet) uses the NATIVE
 * `fetch` (undici), which ignores the node-fetch `agent` option and only honors
 * a dispatcher. client-node offers no per-request undici dispatcher hook, so we
 * bridge via the global dispatcher — restricted by origin so the cluster's
 * `rejectUnauthorized:false` / client cert never leak to non-apiserver hosts.
 *
 * The composed dispatcher is installed ONCE and routes through module state, so
 * config rebuilds only swap `clusterAgent` (closing the previous one to avoid
 * leaking sockets/TLS contexts).
 *
 * Re-runs automatically whenever the cached config is rebuilt (kubeconfig path
 * or active-context change both null the cache).
 */
function installTlsDispatcher(cfg: KubeConfig): void {
  // Retire the previous cluster agent (graceful: lets in-flight requests end).
  if (clusterAgent !== null) {
    void clusterAgent.close();
    clusterAgent = null;
  }
  apiserverOrigin = null;

  const cluster = cfg.getCurrentCluster();
  if (!cluster) return;

  const ca: string[] = [...tls.rootCertificates];
  const clusterCa = pemFromDataOrFile(cluster.caData, cluster.caFile);
  if (clusterCa) ca.push(clusterCa);

  const connect: tls.SecureContextOptions & { rejectUnauthorized?: boolean } = { ca };

  const user = cfg.getCurrentUser();
  if (user) {
    const cert = pemFromDataOrFile(user.certData, user.certFile);
    const key = pemFromDataOrFile(user.keyData, user.keyFile);
    if (cert && key) {
      connect.cert = cert;
      connect.key = key;
    }
  }

  if (cluster.skipTLSVerify) connect.rejectUnauthorized = false;

  apiserverOrigin = originOf(cluster.server);
  clusterAgent = new Agent({ connect });

  if (!dispatcherInstalled) {
    const routeToApiserver: Dispatcher.DispatcherComposeInterceptor =
      (dispatch) => (opts, handler) => {
        if (
          clusterAgent !== null &&
          apiserverOrigin !== null &&
          originOf(opts.origin) === apiserverOrigin
        ) {
          return clusterAgent.dispatch(opts, handler);
        }
        return dispatch(opts, handler);
      };
    setGlobalDispatcher(new Agent().compose(routeToApiserver));
    dispatcherInstalled = true;
  }
}

// ---------------------------------------------------------------------------
// Typed-client auth caching + connection reuse.
//
// KubeConfig.makeApiClient wires the KubeConfig itself in as the request
// authenticator, and its applySecurityAuthentication re-reads ca/cert/key
// FILES synchronously and builds a brand-new `https.Agent` (keepAlive: false)
// on EVERY request — a full TCP+TLS handshake per typed API call. This wrapper
// runs that work once, swaps the agent for a shared keepAlive one, and replays
// the recorded headers/agent onto each request. A short TTL keeps rotating
// tokens working; a config change tears everything down.
// ---------------------------------------------------------------------------

const AUTH_CACHE_TTL_MS = 30_000;

interface RecordedAuth {
  at: number;
  headers: Record<string, string>;
  agent: unknown;
}

class CachedClusterAuth {
  #cfg: KubeConfig;
  #cached: RecordedAuth | null = null;
  #pending: Promise<RecordedAuth> | null = null;

  constructor(cfg: KubeConfig) {
    this.#cfg = cfg;
  }

  getName(): string {
    return 'default';
  }

  /** The cached auth material, rebuilt (single-flight) when the TTL lapses. */
  async getAuth(): Promise<RecordedAuth> {
    if (this.#cached && Date.now() - this.#cached.at < AUTH_CACHE_TTL_MS) {
      return this.#cached;
    }
    // Single-flight: concurrent calls during a refresh share one rebuild.
    if (!this.#pending) {
      const p = this.#build();
      this.#pending = p;
      // Guarded clear: expire() may have replaced #pending with a fresher
      // build by the time this one settles — never null out someone else's.
      void p.finally(() => {
        if (this.#pending === p) this.#pending = null;
      });
    }
    const fresh = await this.#pending;
    if (this.#cached && this.#cached !== fresh) this.#destroyAgent(this.#cached);
    this.#cached = fresh;
    return fresh;
  }

  async applySecurityAuthentication(context: RequestContext): Promise<void> {
    const auth = await this.getAuth();
    for (const [k, v] of Object.entries(auth.headers)) context.setHeaderParam(k, v);
    context.setAgent(auth.agent as Parameters<RequestContext['setAgent']>[0]);
  }

  async #build(): Promise<RecordedAuth> {
    const headers: Record<string, string> = {};
    let agent: unknown;
    // Record what the real implementation would have applied to the request.
    const recorder = {
      setHeaderParam: (key: string, value: string): void => {
        headers[key] = value;
      },
      setAgent: (a: unknown): void => {
        agent = a;
      },
    };
    await this.#cfg.applySecurityAuthentication(recorder as unknown as RequestContext);
    // Rebuild plain https agents with keepAlive so sockets are reused across
    // calls. Proxy agents (constructor !== https.Agent) are kept verbatim.
    if (agent && (agent as object).constructor === https.Agent) {
      const opts = (agent as https.Agent).options ?? {};
      (agent as https.Agent).destroy();
      agent = new https.Agent({ ...opts, keepAlive: true, maxSockets: 16 });
    }
    return { at: Date.now(), headers, agent };
  }

  /** Force the next getAuth() to rebuild (e.g. after a 401), without leaking
   *  the current agent — the rebuild swap destroys it. Also drops an in-flight
   *  rebuild: it started BEFORE the 401, so its material may be the very token
   *  that just got rejected; the next getAuth() starts a fresh build. */
  expire(): void {
    this.#pending = null;
    if (this.#cached) this.#cached = { ...this.#cached, at: 0 };
  }

  #destroyAgent(entry: RecordedAuth): void {
    const agent = entry.agent as { destroy?: () => void } | undefined;
    try {
      agent?.destroy?.();
    } catch {
      // ignore
    }
  }

  destroy(): void {
    if (this.#cached) this.#destroyAgent(this.#cached);
    this.#cached = null;
  }
}

let typedAuth: CachedClusterAuth | null = null;
let typedConfiguration: Configuration | null = null;

onConfigChange(() => {
  typedAuth?.destroy();
  typedAuth = null;
  typedConfiguration = null;
});

function typedConfigFor(cfg: KubeConfig): Configuration {
  if (!typedConfiguration) {
    const cluster = cfg.getCurrentCluster();
    if (!cluster) {
      throw new Error('No active cluster!');
    }
    typedAuth = new CachedClusterAuth(cfg);
    typedConfiguration = createConfiguration({
      baseServer: new ServerConfiguration(cluster.server, {}),
      authMethods: { default: typedAuth },
    });
  }
  return typedConfiguration;
}

/**
 * Cached auth headers for the active cluster, shared with the typed clients
 * (one TTL, one single-flight, one invalidation path). The raw fetch path
 * (api.ts) uses these — its TLS is handled by the undici dispatcher above.
 */
export async function clusterAuthHeaders(): Promise<Record<string, string>> {
  typedConfigFor(kc());
  return (await typedAuth!.getAuth()).headers;
}

/** Force the next auth read to rebuild — call on a 401 (token likely rotated). */
export function expireClusterAuth(): void {
  typedAuth?.expire();
}

/**
 * Generic typed Api factory. Prefer the named getters below; reach for this
 * only when you need an Api class not covered by a dedicated getter.
 *
 *   const metrics = makeApiClient(MetricsV1beta1Api)
 */
export function makeApiClient<T extends ApiType>(apiClientType: ApiConstructor<T>): T {
  const cfg = kc();
  return new apiClientType(typedConfigFor(cfg));
}

export function getCoreV1Api(): CoreV1Api {
  return makeApiClient(CoreV1Api);
}

export function getAppsV1Api(): AppsV1Api {
  return makeApiClient(AppsV1Api);
}

export function getCustomObjectsApi(): CustomObjectsApi {
  return makeApiClient(CustomObjectsApi);
}

export function getApiextensionsV1Api(): ApiextensionsV1Api {
  return makeApiClient(ApiextensionsV1Api);
}

export function getBatchV1Api(): BatchV1Api {
  return makeApiClient(BatchV1Api);
}

export function getNetworkingV1Api(): NetworkingV1Api {
  return makeApiClient(NetworkingV1Api);
}

export function getRbacAuthorizationV1Api(): RbacAuthorizationV1Api {
  return makeApiClient(RbacAuthorizationV1Api);
}

export function getAuthorizationV1Api(): AuthorizationV1Api {
  return makeApiClient(AuthorizationV1Api);
}

export function getVersionApi(): VersionApi {
  return makeApiClient(VersionApi);
}
