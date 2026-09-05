// Handler module: resource watch (streaming).
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
// WatchEvent wire shape (must match src/lib/stores/k8s.logic.ts WatchEvent —
// snake_case top-level):
//   { event_type: "Applied" | "Deleted" | "Resync",
//     resource_type: string,
//     resource: Resource }
//
// Lifecycle notices ride the same channel (k8s.logic.ts WatchNotice):
//   { event_type: "watch_error", resource_type, message }  the stream ended
//       with an error (not a routine server close) and is reconnecting with
//       backoff — the renderer stops showing "Watching" and, when the message
//       is a transport failure, marks the cluster unreachable;
//   { event_type: "watch_open", resource_type }  a reconnect after such an
//       error succeeded.
//
// resource_type may be a built-in kind OR the renderer's `crd:<group>/<Kind>`
// pseudo-type, resolved through CRD discovery (handlers/crd.ts) so custom
// resource tables update live like everything else.
//
// The embedded Resource is snake_case top-level: api_version,
// metadata.{name,namespace,uid,resource_version,creation_timestamp,labels,
// annotations,owner_references}, type. The renderer only reads
// resource.metadata.uid, but we project the full shape so the upsert replaces
// the list item with exactly what list_resources produced.
//
// PROJECTION NOTE: watch events use the SAME per-kind lean projection as
// list_resources (listProjectionFor) — a watch event replaces a list row
// wholesale in the store, so anything fatter than the list shape only bloats
// IPC payloads and renderer-resident memory as the cluster churns.
//
// TYPE TRANSLATION: the JS Watch is a RAW watch stream of verbs
// (ADDED/MODIFIED/DELETED/BOOKMARK/ERROR), and the initial connect replays the
// current list as ADDED. The store speaks desired state instead, so we map
// ADDED/MODIFIED -> "Applied" and
// DELETED -> "Deleted". Replaying the initial ADDEDs is harmless: the renderer's
// handleWatchEvent upserts by uid, so items already loaded are simply re-applied.

import { Watch } from '@kubernetes/client-node';

import { getActiveContextName, kc, onConfigChange } from '../k8s/client';
import { apiGet, META_ACCEPT } from '../k8s/api';
import { describeInvokeError } from '../k8s/errors';
import type { RawObject, Resource } from '../k8s/resource-types';
import { listDynamicToResource, listProjectionFor } from '../k8s/resource-mapping';
import { apiVersionOf, resolveResourceType } from '../k8s/kinds';
import type { Handler, HandlerCtx, HandlerMap } from '../dispatch';
import { parseCrdType, resolveCrdType } from './crd';

const WATCH_CHANNEL = 'resource-watch-event';

/** Max watch events to buffer before flushing a batch. */
const WATCH_BATCH_SIZE = 20;
/** Max time (ms) to hold a partial batch before flushing it. */
const WATCH_FLUSH_INTERVAL_MS = 50;
/** Reconnect backoff: base delay, doubled per unhealthy cycle up to the cap. */
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;
/** A connection must survive this long before it counts as healthy (resets backoff). */
const HEALTHY_CONN_MS = 10_000;

// ---------------------------------------------------------------------------
// Wire types. Resource/RawObject come from the shared k8s core; only the
// watch-specific WatchEvent envelope lives here.
// ---------------------------------------------------------------------------

interface WatchEvent {
  event_type: 'Applied' | 'Deleted' | 'Resync';
  resource_type: string;
  resource: Resource;
}

interface WatchNotice {
  event_type: 'watch_error' | 'watch_open';
  resource_type: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// ApiResource resolution — built-in kinds read the shared registry in
// k8s/kinds.ts (a watchable resource_type is exactly a listable one); a
// `crd:` pseudo-type resolves through CRD discovery.
// ---------------------------------------------------------------------------

export interface ApiResource {
  group: string;
  version: string;
  apiVersion: string;
  kind: string;
  plural: string;
  clusterScoped: boolean;
}

/**
 * Resolve (group, version, kind, plural, scope) for a watch resource_type.
 * `resolveCrd` is the discovery lookup; tests inject a stub.
 */
export async function resolveWatchTarget(
  resourceType: string,
  resolveCrd: typeof resolveCrdType = resolveCrdType,
): Promise<ApiResource | undefined> {
  const crdRef = parseCrdType(resourceType);
  if (crdRef) {
    const crd = await resolveCrd(crdRef.group, crdRef.kind);
    if (!crd) return undefined;
    return {
      group: crd.group,
      version: crd.version,
      apiVersion: apiVersionOf(crd.group, crd.version),
      kind: crd.kind,
      plural: crd.plural,
      clusterScoped: crd.scope === 'Cluster',
    };
  }
  const entry = resolveResourceType(resourceType);
  if (!entry) return undefined;
  const { group, version, kind, plural, clusterScoped } = entry;
  return { group, version, apiVersion: apiVersionOf(group, version), kind, plural, clusterScoped };
}

/**
 * Why a watch stream ended, as a user-facing message — or null when it ended
 * the way streams are meant to: cleanly (the apiserver's periodic close) or
 * because we aborted it. Only a non-null reason is reported to the renderer.
 */
export function describeWatchEnd(err: unknown): string | null {
  if (!err) return null;
  const e = err as { name?: unknown; message?: unknown };
  if (e.name === 'AbortError') return null;
  if (typeof e.message === 'string' && /aborted/i.test(e.message)) return null;
  return describeInvokeError(err);
}

/**
 * REST list path for the watch (the Watch API appends ?watch=true itself).
 * Core-group resources live under /api/v1/...; grouped under /apis/{g}/{v}/...
 * Namespaced kinds scope to the namespace only when one is provided AND the
 * kind is namespaced. Cluster-scoped kinds, and namespaced kinds with no
 * namespace, watch across all namespaces.
 */
export function watchPath(ar: ApiResource, namespace?: string): string {
  const base = ar.group === '' ? `/api/${ar.version}` : `/apis/${ar.group}/${ar.version}`;
  if (!ar.clusterScoped && namespace !== undefined && namespace !== '') {
    return `${base}/namespaces/${encodeURIComponent(namespace)}/${ar.plural}`;
  }
  return `${base}/${ar.plural}`;
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

// Projections live in electron/k8s/resource-mapping.ts (shared with the
// resources and CRD paths): listProjectionFor gives the per-kind lean list
// shape; listDynamicToResource is the verbatim fallback for unknown kinds.

// ---------------------------------------------------------------------------
// Single active watch slot.
// ---------------------------------------------------------------------------

interface ActiveWatch {
  /** Aborts the in-flight HTTP watch request. */
  controller: AbortController | null;
  /** On-demand flush timer for the pending batch (armed only while events wait). */
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** Pending reconnect timer, so stop() cancels a scheduled retry. */
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** Pending (un-emitted) events. */
  batch: WatchEvent[];
  /** Whether a reconnect has already established the first sync. */
  hadInitialSync: boolean;
  /** Current reconnect delay; doubles per unhealthy cycle, resets when healthy. */
  backoffMs: number;
  /** Timestamp the current connection opened (0 = not connected). */
  openedAt: number;
  /** Set true by stop() so reconnect loops bail. */
  stopped: boolean;
  /**
   * Last resourceVersion seen (seeded from the list, advanced by every event +
   * bookmark). While set, (re)connects resume from it — the server sends only
   * NEW deltas instead of replaying the whole list as ADDED, and no Resync
   * (full renderer relist) is needed. Cleared on 410 Gone (history expired),
   * which forces the classic replay + Resync path once.
   */
  lastRV: string | undefined;
  /** Context the watch was opened against, to stop it when the user leaves. */
  contextName: string | undefined;
  /**
   * Settles the pending `start_resource_watch` invoke with a rejection, set
   * only while that first open is in flight. clearActive() calls this so a
   * context switch (or a new/stopped watch) racing the first open can't leave
   * the invoke's promise pending forever — the success/error paths inside
   * connect() both no-op once `isCurrent()` is false, so nothing else would
   * ever settle it.
   */
  cancelStart: ((err: unknown) => void) | null;
}

// Identity of the live ActiveWatch is the generation token: callbacks captured
// over a given `state` no-op once `active` no longer points at that same object
// (clearActive sets active=null and state.stopped=true).
let active: ActiveWatch | null = null;

function clearActive(): void {
  if (active) {
    active.stopped = true;
    if (active.flushTimer) {
      clearTimeout(active.flushTimer);
      active.flushTimer = null;
    }
    if (active.reconnectTimer) {
      clearTimeout(active.reconnectTimer);
      active.reconnectTimer = null;
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
    if (active.cancelStart) {
      const cancel = active.cancelStart;
      active.cancelStart = null;
      cancel(new Error('watch cancelled before it finished opening'));
    }
  }
  active = null;
}

// ---------------------------------------------------------------------------
// start_resource_watch / stop_resource_watch
// ---------------------------------------------------------------------------

async function startResourceWatch(
  resourceType: string,
  namespace: string | undefined,
  listResourceVersion: string | undefined,
  ctx: HandlerCtx,
): Promise<void> {
  // Resolve BEFORE taking the slot: a CRD type awaits discovery, and clearing
  // the slot first would let a second start that lands during the await be
  // overwritten by this one's `active = state` below.
  const ar = await resolveWatchTarget(resourceType);
  if (!ar) {
    throw new Error(`Unknown resource type for watch: ${resourceType}`);
  }

  // Stop any existing watcher first (single active slot).
  clearActive();

  const state: ActiveWatch = {
    controller: null,
    flushTimer: null,
    reconnectTimer: null,
    batch: [],
    // With a list RV the initial sync IS the list the renderer just loaded.
    hadInitialSync: !!listResourceVersion,
    backoffMs: BACKOFF_BASE_MS,
    openedAt: 0,
    stopped: false,
    lastRV: listResourceVersion,
    contextName: getActiveContextName(),
    cancelStart: null,
  };
  active = state;

  const path = watchPath(ar, namespace);
  // Same lean projection as list_resources, resolved once for the whole watch:
  // the renderer replaces the list row wholesale, so shipping more than the
  // list shape only bloats IPC and renderer memory. Fallback keeps unknown
  // types on the generic verbatim shape.
  const project =
    listProjectionFor(resourceType) ??
    ((obj: RawObject) => listDynamicToResource(obj, ar.apiVersion, ar.kind));

  const isCurrent = (): boolean => active === state && !state.stopped;

  const flush = (): void => {
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    if (state.batch.length === 0) return;
    const out = state.batch;
    state.batch = [];
    if (!isCurrent()) return;
    ctx.emit(WATCH_CHANNEL, out);
  };

  const pushEvent = (eventType: 'Applied' | 'Deleted', obj: RawObject): void => {
    if (!isCurrent()) return;
    state.batch.push({
      event_type: eventType,
      resource_type: resourceType,
      resource: project(obj),
    });
    if (state.batch.length >= WATCH_BATCH_SIZE) {
      flush();
    } else if (!state.flushTimer) {
      // On-demand flush timer (logs.ts pattern) so low-rate updates aren't held
      // back but an idle watch keeps no interval ticking.
      state.flushTimer = setTimeout(flush, WATCH_FLUSH_INTERVAL_MS);
    }
  };

  /** Lifecycle notice — see the header comment. */
  const emitNotice = (eventType: WatchNotice['event_type'], message?: string): void => {
    if (!isCurrent()) return;
    const notice: WatchNotice = { event_type: eventType, resource_type: resourceType };
    if (message) notice.message = message;
    ctx.emit(WATCH_CHANNEL, [notice]);
  };

  /** Tell the renderer to do a full relist (covers deltas a watch can't replay). */
  const emitResync = (): void => {
    ctx.emit(WATCH_CHANNEL, [
      {
        event_type: 'Resync',
        resource_type: resourceType,
        resource: { api_version: '', kind: '', metadata: {} },
      } satisfies WatchEvent,
    ]);
  };

  const watch = new Watch(kc());

  // The start invoke resolves/rejects with the FIRST connection attempt only:
  // resolve when the watch opens, reject if that first open fails. Later
  // reconnects run in background with backoff and never surface here.
  let settled = false;

  // Set when the server reports 410 Gone (RV expired): the next close must
  // emit a Resync even if the connection was short-lived, because the
  // no-RV reconnect's replay cannot cover deletes missed during the gap.
  let rvExpired = false;

  // Set when a stream ended with an error (watch_error sent); the next
  // successful open answers it with watch_open.
  let errored = false;

  return await new Promise<void>((resolve, reject) => {
    const settleOk = (): void => {
      if (!settled) {
        settled = true;
        state.cancelStart = null;
        resolve();
      }
    };
    const settleErr = (err: unknown): void => {
      if (!settled) {
        settled = true;
        state.cancelStart = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    // clearActive() calls this if the watch is torn down (context switch, a
    // new start, or an explicit stop) before the first open settles either way.
    state.cancelStart = settleErr;

    /**
     * Reconnecting with NO resourceVersion makes the apiserver replay the
     * whole collection as ADDED — N projections + N/20 IPC batches that the
     * renderer's Resync relist duplicates anyway. When the RV expired (410),
     * grab a fresh one from a metadata-only limit=1 list instead: the list's
     * RV is a valid watch start point, and the Resync relist covers anything
     * missed in between. Falls back to the classic replay on failure.
     */
    const seedRV = async (): Promise<void> => {
      try {
        const list = await apiGet<{ metadata?: { resourceVersion?: string } }>(
          path,
          { limit: '1' },
          META_ACCEPT,
        );
        const rv = list?.metadata?.resourceVersion;
        if (rv && isCurrent() && !state.lastRV) state.lastRV = rv;
      } catch {
        // keep lastRV unset — the reconnect replays and the Resync path holds
      }
    };

    /** Schedule a reconnect with exponential backoff + jitter (0.5x-1x the delay). */
    const scheduleReconnect = (): void => {
      if (!isCurrent()) return;
      const delay = Math.round(state.backoffMs * (0.5 + Math.random() * 0.5));
      state.backoffMs = Math.min(state.backoffMs * 2, BACKOFF_MAX_MS);
      state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = null;
        if (!state.lastRV && state.hadInitialSync) {
          void seedRV().then(connect);
        } else {
          connect();
        }
      }, delay);
    };

    // Establish (or re-establish) the watch connection. On stream close the JS
    // Watch does NOT auto-relist, so we reconnect ourselves. A Resync (which
    // makes the store do a full relist) is emitted only for a close that left a
    // gap — see the close handler below for the exact rule.
    const connect = (): void => {
      if (!isCurrent()) return;

      // The JS Watch resolves its promise with the controller EVEN WHEN the
      // connect failed — the failure goes to the done callback first, then
      // the promise resolves. `ended` tells the two apart: a done() before
      // the .then means this attempt never opened.
      let ended = false;

      // Resume from the last seen RV when we have one: the server then sends
      // only deltas newer than the list/previous stream — no ADDED replay of
      // the entire list on every (re)connect. Bookmarks keep lastRV fresh even
      // when the resource is quiet, so a resume stays possible after the
      // server's periodic stream close.
      const query: Record<string, string | number | boolean | undefined> = {
        allowWatchBookmarks: true,
      };
      if (state.lastRV) query.resourceVersion = state.lastRV;

      watch
        .watch(
          path,
          query,
          (type: string, obj: RawObject) => {
            if (!isCurrent()) return;
            const rv = obj?.metadata?.resourceVersion;
            switch (type) {
              case 'ADDED':
              case 'MODIFIED':
                if (rv) state.lastRV = rv;
                pushEvent('Applied', obj);
                break;
              case 'DELETED':
                if (rv) state.lastRV = rv;
                pushEvent('Deleted', obj);
                break;
              case 'BOOKMARK':
                if (rv) state.lastRV = rv;
                break;
              case 'ERROR': {
                // Status object; 410 Gone = our RV expired from watch history.
                // Clear it so the next reconnect does a fresh replay + Resync
                // (the relist covers any deletes we missed).
                const code = (obj as { code?: number } | undefined)?.code;
                if (code === 410) {
                  state.lastRV = undefined;
                  rvExpired = true;
                }
                break;
              }
              default:
                break;
            }
          },
          (err: unknown) => {
            // Stream ended (close, timeout, or error). Flush pending deltas.
            ended = true;
            if (!isCurrent()) return;
            const failure = describeWatchEnd(err);
            // eslint-disable-next-line no-console
            console.error(
              `[watch] stream ended for ${resourceType} (hadInitialSync=${state.hadInitialSync})`,
              err instanceof Error ? err.message : err,
            );
            flush();
            state.controller = null;

            // The FIRST attempt never opened: reject the start invoke with the
            // real reason (a transport failure lets the renderer mark the
            // cluster unreachable) instead of resolving as if a watch were
            // running and retrying in the dark.
            if (failure && !settled) {
              settleErr(new Error(failure));
              clearActive();
              return;
            }
            if (failure) {
              errored = true;
              emitNotice('watch_error', failure);
            }

            // A connection that survived a while is "healthy": reset the
            // backoff. An unhealthy one (flapping) keeps growing it, and its
            // close emits NO Resync — the renderer does a full relist per
            // Resync, so a flapping watch must not relist in a loop.
            const healthy = state.openedAt > 0 && Date.now() - state.openedAt >= HEALTHY_CONN_MS;
            state.openedAt = 0;
            if (healthy) state.backoffMs = BACKOFF_BASE_MS;

            if (state.hadInitialSync) {
              // A resumable close (lastRV still valid) leaves NO gap: the
              // reconnect picks up exactly where the stream ended, so no
              // Resync — the renderer never has to do a full relist for the
              // server's routine stream closes. A Resync (full refresh, since
              // missed deletes can't be replayed) is only needed when the RV
              // expired (410) or a healthy stream closed without one. Flapping
              // non-410 closes keep the healthy gate so a broken watch can't
              // relist in a loop.
              if (!state.lastRV && (healthy || rvExpired)) {
                rvExpired = false;
                emitResync();
              }
            } else {
              // First connection's natural close (e.g. the 30s server window)
              // becomes the boundary after which reconnects count as resyncs.
              state.hadInitialSync = true;
            }

            scheduleReconnect();
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
          // Failed open: the done callback already scheduled the reconnect
          // (or rejected the start). Recording it as "opened" would make the
          // next close look healthy and reset the backoff.
          if (ended) return;
          state.controller = controller;
          state.openedAt = Date.now();
          if (errored) {
            errored = false;
            emitNotice('watch_open');
          }
          settleOk();
        })
        .catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.error(
            `[watch] failed to open watch for ${resourceType} (hadInitialSync=${state.hadInitialSync})`,
            err instanceof Error ? err.message : err,
          );
          // A 410 at open means our resume RV already expired. Drop it (the
          // retry seeds a fresh RV, or replays if that fails) and tell the
          // renderer to relist NOW: deletes that happened past the expired RV
          // can never be replayed, so without this Resync stale rows would
          // linger until some later healthy-close resync.
          const status = (err as { code?: number; statusCode?: number } | undefined);
          if (status?.code === 410 || status?.statusCode === 410) {
            state.lastRV = undefined;
            rvExpired = false;
            if (state.hadInitialSync && isCurrent()) emitResync();
          }
          // Failed to OPEN the watch. If this is the first attempt, tear down
          // and reject the start invoke; otherwise keep the loop alive with
          // backoff so a transient open failure (e.g. a token refresh) doesn't
          // strand the list empty until the next user action.
          if (isCurrent() && !settled) {
            settleErr(new Error(describeInvokeError(err)));
            clearActive();
            return;
          }
          const failure = describeWatchEnd(err);
          if (failure) {
            errored = true;
            emitNotice('watch_error', failure);
          }
          scheduleReconnect();
        });
    };

    connect();
  });
}

/** Stop the active watch (renderer reload/crash cleanup — main.ts hooks). */
export function stopAllWatches(): void {
  clearActive();
}

export function register(handlers: HandlerMap, ctx: HandlerCtx): void {
  const startHandler: Handler = async (args) => {
    const resourceType = typeof args.resourceType === 'string' ? args.resourceType : '';
    // namespace is Option<String>; the frontend sends a string (possibly empty)
    // or null for cluster-wide. Treat empty/missing as "all namespaces".
    const namespace =
      typeof args.namespace === 'string' && args.namespace.length > 0 ? args.namespace : undefined;
    // Optional: the resourceVersion of the list the renderer just rendered.
    // When present the watch resumes from it instead of replaying the list.
    const resourceVersion =
      typeof args.resourceVersion === 'string' && args.resourceVersion.length > 0
        ? args.resourceVersion
        : undefined;
    await startResourceWatch(resourceType, namespace, resourceVersion, ctx);
    return null;
  };

  const stopHandler: Handler = async () => {
    clearActive();
    return null;
  };

  handlers.set('start_resource_watch', startHandler);
  handlers.set('stop_resource_watch', stopHandler);

  // The Watch captured the KubeConfig of the cluster it was opened against;
  // after a context switch it kept streaming (and reconnecting, with backoff)
  // from the OLD cluster until the renderer happened to start a new watch.
  // Only a context change stops it: a kubeconfig rewrite that keeps the
  // context (an import) must not silently end live updates.
  onConfigChange(() => {
    if (!active) return;
    let current: string | undefined;
    try {
      current = getActiveContextName();
    } catch {
      current = undefined;
    }
    if (current !== active.contextName) clearActive();
  });
}
