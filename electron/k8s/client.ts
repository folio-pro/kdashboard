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

import {
  KubeConfig,
  CoreV1Api,
  AppsV1Api,
  CustomObjectsApi,
  ApiextensionsV1Api,
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
 * Set (or clear) the kubeconfig file path override. Pass null to fall back to
 * the default loader. Invalidates the cached config so the next kc() reloads.
 */
export function setKubeconfigPath(path: string | null): void {
  kubeconfigPathOverride = path && path.trim().length > 0 ? path : null;
  cachedConfig = null;
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
  cachedConfig = null;
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
  }
  return cachedConfig;
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

export function getVersionApi(): VersionApi {
  return kc().makeApiClient(VersionApi);
}
