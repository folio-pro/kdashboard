// Shared @kubernetes/client-node configuration + typed Api factory helpers.
//
// Every k8s handler MUST go through these helpers rather than constructing its
// own KubeConfig — this keeps a single source of truth for the active context
// and the optional kubeconfig path override coming from settings.
//
// Mirrors the Rust src-tauri/src/k8s/client.rs behaviour:
//   - load from default kubeconfig (KUBECONFIG env / ~/.kube/config)
//   - honor a kubeconfigPath override persisted in settings
//   - allow switching the active context at runtime (switch_context)

import * as fs from 'node:fs';
import * as tls from 'node:tls';

import { Agent, setGlobalDispatcher, type Dispatcher } from 'undici';

import {
  KubeConfig,
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

function invalidateConfig(): void {
  cachedConfig = null;
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

/**
 * Generic typed Api factory. Prefer the named getters below; reach for this
 * only when you need an Api class not covered by a dedicated getter.
 *
 *   const metrics = makeApiClient(MetricsV1beta1Api)
 */
export function makeApiClient<T extends ApiType>(apiClientType: ApiConstructor<T>): T {
  return kc().makeApiClient(apiClientType);
}

export function getCoreV1Api(): CoreV1Api {
  return kc().makeApiClient(CoreV1Api);
}

export function getAppsV1Api(): AppsV1Api {
  return kc().makeApiClient(AppsV1Api);
}

export function getCustomObjectsApi(): CustomObjectsApi {
  return kc().makeApiClient(CustomObjectsApi);
}

export function getApiextensionsV1Api(): ApiextensionsV1Api {
  return kc().makeApiClient(ApiextensionsV1Api);
}

export function getBatchV1Api(): BatchV1Api {
  return kc().makeApiClient(BatchV1Api);
}

export function getNetworkingV1Api(): NetworkingV1Api {
  return kc().makeApiClient(NetworkingV1Api);
}

export function getRbacAuthorizationV1Api(): RbacAuthorizationV1Api {
  return kc().makeApiClient(RbacAuthorizationV1Api);
}

export function getAuthorizationV1Api(): AuthorizationV1Api {
  return kc().makeApiClient(AuthorizationV1Api);
}

export function getVersionApi(): VersionApi {
  return kc().makeApiClient(VersionApi);
}
