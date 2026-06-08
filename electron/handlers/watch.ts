// Handler module: resource watch (streaming).
//
// Ports src-tauri/src/k8s/watch.rs to @kubernetes/client-node's Watch.
//
// Commands:
//   - start_resource_watch   begin watching one resource type (single active
//                            slot — replaces any existing watch)
//   - stop_resource_watch    abort the active watch
//
// Event channel:
//   - resource-watch-event   emits an ARRAY of WatchEvent (the renderer handles
//                            both a single object and an array; we always batch).
//
// WatchEvent wire shape (must match src/lib/stores/k8s.logic.ts WatchEvent and
// the Rust WatchEvent struct — NO serde rename_all, so snake_case top-level):
//   { event_type: "Applied" | "Deleted" | "Resync",
//     resource_type: string,
//     resource: Resource }
//
// The embedded Resource matches the Rust Resource struct (snake_case top-level:
// api_version, metadata.{name,namespace,uid,resource_version,creation_timestamp,
// labels,annotations,owner_references}; `type` renamed from type_). The renderer
// only reads resource.metadata.uid, but we project the full struct faithfully so
// the upsert replaces the list item with the same shape list_resources produced.
//
// PROJECTION NOTE: watch.rs uses the GENERIC dynamic_to_resource projection —
// spec/status/data are taken VERBATIM from the object body for every kind (NOT
// the lean per-kind pod projection used by list_resources). We mirror that here.
//
// TYPE TRANSLATION: the kube `watcher` runtime the Rust used emits desired-state
// events (Apply/Delete) and skips the initial list. The JS Watch is a RAW watch
// stream of verbs (ADDED/MODIFIED/DELETED/BOOKMARK/ERROR), so the initial connect
// replays the current list as ADDED. We map ADDED/MODIFIED -> "Applied" and
// DELETED -> "Deleted". Replaying the initial ADDEDs is harmless: the renderer's
// handleWatchEvent upserts by uid, so items already loaded are simply re-applied.

import { Watch } from '@kubernetes/client-node';

import { kc } from '../k8s/client';
import type { RawObject, Resource } from '../k8s/resource-types';
import { dynamicToResource } from '../k8s/resource-mapping';
import type { Handler, HandlerCtx, HandlerMap } from '../dispatch';

const WATCH_CHANNEL = 'resource-watch-event';

/** Max watch events to buffer before flushing a batch (mirrors watch.rs). */
const WATCH_BATCH_SIZE = 20;
/** Max time (ms) to hold a partial batch before flushing it. */
const WATCH_FLUSH_INTERVAL_MS = 50;

// ---------------------------------------------------------------------------
// Wire types. Resource/RawObject come from the shared k8s core; only the
// watch-specific WatchEvent envelope lives here.
// ---------------------------------------------------------------------------

interface WatchEvent {
  event_type: 'Applied' | 'Deleted' | 'Resync';
  resource_type: string;
  resource: Resource;
}

// ---------------------------------------------------------------------------
// ApiResource resolution — port of watch.rs api_resource_for_type. Note this is
// the watch-specific table (it lacks `vpa`, matching watch.rs exactly).
// ---------------------------------------------------------------------------

interface ApiResource {
  group: string;
  version: string;
  apiVersion: string;
  kind: string;
  plural: string;
  clusterScoped: boolean;
}

function apiVersionOf(group: string, version: string): string {
  return group === '' ? version : `${group}/${version}`;
}

/** Resolve (group, version, kind, plural, scope) for a watch resource_type. */
function apiResourceForType(resourceType: string): ApiResource | undefined {
  // [group, version, kind, plural, clusterScoped]
  const table: Record<string, [string, string, string, string, boolean]> = {
    pods: ['', 'v1', 'Pod', 'pods', false],
    deployments: ['apps', 'v1', 'Deployment', 'deployments', false],
    services: ['', 'v1', 'Service', 'services', false],
    configmaps: ['', 'v1', 'ConfigMap', 'configmaps', false],
    secrets: ['', 'v1', 'Secret', 'secrets', false],
    ingresses: ['networking.k8s.io', 'v1', 'Ingress', 'ingresses', false],
    statefulsets: ['apps', 'v1', 'StatefulSet', 'statefulsets', false],
    daemonsets: ['apps', 'v1', 'DaemonSet', 'daemonsets', false],
    jobs: ['batch', 'v1', 'Job', 'jobs', false],
    cronjobs: ['batch', 'v1', 'CronJob', 'cronjobs', false],
    replicasets: ['apps', 'v1', 'ReplicaSet', 'replicasets', false],
    nodes: ['', 'v1', 'Node', 'nodes', true],
    namespaces: ['', 'v1', 'Namespace', 'namespaces', true],
    hpa: ['autoscaling', 'v2', 'HorizontalPodAutoscaler', 'horizontalpodautoscalers', false],
    networkpolicies: ['networking.k8s.io', 'v1', 'NetworkPolicy', 'networkpolicies', false],
    persistentvolumes: ['', 'v1', 'PersistentVolume', 'persistentvolumes', true],
    persistentvolumeclaims: ['', 'v1', 'PersistentVolumeClaim', 'persistentvolumeclaims', false],
    storageclasses: ['storage.k8s.io', 'v1', 'StorageClass', 'storageclasses', true],
    roles: ['rbac.authorization.k8s.io', 'v1', 'Role', 'roles', false],
    rolebindings: ['rbac.authorization.k8s.io', 'v1', 'RoleBinding', 'rolebindings', false],
    clusterroles: ['rbac.authorization.k8s.io', 'v1', 'ClusterRole', 'clusterroles', true],
    clusterrolebindings: [
      'rbac.authorization.k8s.io',
      'v1',
      'ClusterRoleBinding',
      'clusterrolebindings',
      true,
    ],
    resourcequotas: ['', 'v1', 'ResourceQuota', 'resourcequotas', false],
    limitranges: ['', 'v1', 'LimitRange', 'limitranges', false],
    poddisruptionbudgets: ['policy', 'v1', 'PodDisruptionBudget', 'poddisruptionbudgets', false],
  };
  const row = table[resourceType];
  if (!row) return undefined;
  const [group, version, kind, plural, clusterScoped] = row;
  return { group, version, apiVersion: apiVersionOf(group, version), kind, plural, clusterScoped };
}

/**
 * REST list path for the watch (the Watch API appends ?watch=true itself).
 * Core-group resources live under /api/v1/...; grouped under /apis/{g}/{v}/...
 * Namespaced kinds scope to the namespace only when one is provided AND the
 * kind is namespaced (mirrors watch.rs: namespaced_with when Some(ns), else
 * all_with — i.e. cluster-scoped, or namespaced with no ns = all namespaces).
 */
function watchPath(ar: ApiResource, namespace?: string): string {
  const base = ar.group === '' ? `/api/${ar.version}` : `/apis/${ar.group}/${ar.version}`;
  if (!ar.clusterScoped && namespace !== undefined && namespace !== '') {
    return `${base}/namespaces/${encodeURIComponent(namespace)}/${ar.plural}`;
  }
  return `${base}/${ar.plural}`;
}

// ---------------------------------------------------------------------------
// Projection — port of helpers.rs meta_from + watch.rs dynamic_to_resource.
// ---------------------------------------------------------------------------

// dynamic_to_resource + meta_from now live in electron/k8s/resource-mapping.ts
// (shared with the resources and CRD paths). watch.rs uses the GENERIC
// projection — spec/status/data taken verbatim for every kind — which is
// exactly what the shared dynamicToResource does.

// ---------------------------------------------------------------------------
// Single active watch slot (mirrors watch.rs WATCHER_ABORT / WATCHER_RUNNING).
// ---------------------------------------------------------------------------

interface ActiveWatch {
  /** Aborts the in-flight HTTP watch request. */
  controller: AbortController | null;
  /** Flush timer for the pending batch. */
  flushTimer: ReturnType<typeof setInterval> | null;
  /** Pending (un-emitted) events. */
  batch: WatchEvent[];
  /** Whether a reconnect has already established the first sync. */
  hadInitialSync: boolean;
  /** Set true by stop() so reconnect loops bail. */
  stopped: boolean;
}

// Identity of the live ActiveWatch is the generation token: callbacks captured
// over a given `state` no-op once `active` no longer points at that same object
// (clearActive sets active=null and state.stopped=true).
let active: ActiveWatch | null = null;

function clearActive(): void {
  if (active) {
    active.stopped = true;
    if (active.flushTimer) {
      clearInterval(active.flushTimer);
      active.flushTimer = null;
    }
    if (active.controller) {
      try {
        active.controller.abort();
      } catch {
        // already aborted
      }
      active.controller = null;
    }
    active.batch = [];
  }
  active = null;
}

// ---------------------------------------------------------------------------
// start_resource_watch / stop_resource_watch
// ---------------------------------------------------------------------------

async function startResourceWatch(
  resourceType: string,
  namespace: string | undefined,
  ctx: HandlerCtx,
): Promise<void> {
  // Stop any existing watcher first (single active slot, like watch.rs).
  clearActive();

  const ar = apiResourceForType(resourceType);
  if (!ar) {
    throw new Error(`Unknown resource type for watch: ${resourceType}`);
  }

  const state: ActiveWatch = {
    controller: null,
    flushTimer: null,
    batch: [],
    hadInitialSync: false,
    stopped: false,
  };
  active = state;

  const path = watchPath(ar, namespace);
  const apiVersion = ar.apiVersion;
  const kind = ar.kind;

  const isCurrent = (): boolean => active === state && !state.stopped;

  const flush = (): void => {
    if (state.batch.length === 0) return;
    const out = state.batch;
    state.batch = [];
    if (!isCurrent()) return;
    ctx.emit(WATCH_CHANNEL, out);
  };

  // Periodic flush so low-rate updates aren't held back (watch.rs flush window).
  state.flushTimer = setInterval(flush, WATCH_FLUSH_INTERVAL_MS);

  const pushEvent = (eventType: 'Applied' | 'Deleted', obj: RawObject): void => {
    if (!isCurrent()) return;
    state.batch.push({
      event_type: eventType,
      resource_type: resourceType,
      resource: dynamicToResource(obj, apiVersion, kind),
    });
    if (state.batch.length >= WATCH_BATCH_SIZE) flush();
  };

  const watch = new Watch(kc());

  // Establish (or re-establish) the watch connection. On stream close the JS
  // Watch does NOT auto-relist (unlike the kube `watcher` runtime), so we
  // reconnect ourselves and emit a Resync after the first sync — mirroring
  // watch.rs's InitDone-on-resync behaviour so the store does a full refresh.
  const connect = (): void => {
    if (!isCurrent()) return;

    watch
      .watch(
        path,
        {},
        (type: string, obj: RawObject) => {
          if (!isCurrent()) return;
          switch (type) {
            case 'ADDED':
            case 'MODIFIED':
              pushEvent('Applied', obj);
              break;
            case 'DELETED':
              pushEvent('Deleted', obj);
              break;
            // BOOKMARK / ERROR carry no resource delta the store consumes.
            default:
              break;
          }
        },
        (err: unknown) => {
          // Stream ended (close, timeout, or error). Flush pending deltas.
          if (!isCurrent()) return;
          // eslint-disable-next-line no-console
          console.error(
            `[watch] stream ended for ${resourceType} (hadInitialSync=${state.hadInitialSync})`,
            err instanceof Error ? err.message : err,
          );
          flush();
          state.controller = null;

          if (state.hadInitialSync) {
            // Re-sync after a disconnect: emit a Resync so the store triggers a
            // full refresh (matches watch.rs InitDone-on-resync), then reconnect.
            if (isCurrent()) {
              ctx.emit(WATCH_CHANNEL, [
                {
                  event_type: 'Resync',
                  resource_type: resourceType,
                  resource: {
                    api_version: '',
                    kind: '',
                    metadata: {},
                  },
                } satisfies WatchEvent,
              ]);
            }
          } else {
            // First connection's natural close (e.g. the 30s server window)
            // becomes the boundary after which reconnects count as resyncs.
            state.hadInitialSync = true;
          }
          void err; // surfaced via Resync + reconnect; nothing to throw here.

          // Reconnect on the next tick unless we've been stopped/replaced.
          if (isCurrent()) {
            setTimeout(connect, 0);
          }
        },
      )
      .then((controller: AbortController) => {
        if (!isCurrent()) {
          // We were stopped/replaced while the request was being set up.
          try {
            controller.abort();
          } catch {
            // ignore
          }
          return;
        }
        state.controller = controller;
      })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error(
          `[watch] failed to open watch for ${resourceType} (hadInitialSync=${state.hadInitialSync})`,
          err instanceof Error ? err.message : err,
        );
        // Failed to OPEN the watch. Reject the start promise only if this is the
        // active, never-synced watch; otherwise keep the loop alive by retrying,
        // so a transient open failure (e.g. a token refresh) doesn't strand the
        // list empty until the next user action.
        if (isCurrent() && !state.hadInitialSync) {
          clearActive();
          throw err instanceof Error ? err : new Error(String(err));
        }
        if (isCurrent()) {
          setTimeout(connect, 1000);
        }
      });
  };

  connect();
}

export function register(handlers: HandlerMap, ctx: HandlerCtx): void {
  const startHandler: Handler = async (args) => {
    const resourceType = typeof args.resourceType === 'string' ? args.resourceType : '';
    // namespace is Option<String>; the frontend sends a string (possibly empty)
    // or null for cluster-wide. Treat empty/missing as "all namespaces".
    const namespace =
      typeof args.namespace === 'string' && args.namespace.length > 0 ? args.namespace : undefined;
    await startResourceWatch(resourceType, namespace, ctx);
    return null;
  };

  const stopHandler: Handler = async () => {
    clearActive();
    return null;
  };

  handlers.set('start_resource_watch', startHandler);
  handlers.set('stop_resource_watch', stopHandler);
}
