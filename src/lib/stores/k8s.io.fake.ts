import type { ResourceList, CrdGroup, CrdInfo, CrdResourceList } from "../types/index.js";
import type {
  KubeIo,
  Unsubscribe,
  WatchEventPayload,
  PortForwardStartArgs,
  PortForwardStartResult,
  CrdListArgs,
} from "./k8s.io.js";

/**
 * In-memory KubeIo for tests. The second adapter that makes the seam real:
 * it lets bun test drive the full load → cache → watch → reconcile state
 * machine of K8sStoreLogic without a cluster.
 *
 * Tests control what `listResources` returns (set `listResult` / `listError`)
 * and push watch traffic through `emitWatch(...)` — the store's live watcher
 * would deliver exactly the same payloads.
 */
export class FakeKubeIo implements KubeIo {
  // ── Test-controllable resource surface ──
  listResult: ResourceList = { items: [], resource_type: "" };
  listError: unknown = null;
  counts: Record<string, number> = {};

  // ── Observability for assertions ──
  listCalls: Array<{ resourceType: string; namespace: string }> = [];
  watchStarted: { resourceType: string; namespace: string } | null = null;
  watchStopCount = 0;
  currentContext: string | null = null;

  private _watchCb: ((payload: WatchEventPayload) => void) | null = null;

  /** Set what the next listResources call resolves to. */
  setList(items: ResourceList["items"], resourceType: string): void {
    this.listResult = { items, resource_type: resourceType };
  }

  /** Push a watch event (or batch) as the backend would deliver it. */
  emitWatch(payload: WatchEventPayload): void {
    this._watchCb?.(payload);
  }

  /** Whether a watch subscription is currently attached. */
  get isWatching(): boolean {
    return this._watchCb !== null;
  }

  listResources(resourceType: string, namespace: string): Promise<ResourceList> {
    this.listCalls.push({ resourceType, namespace });
    if (this.listError) return Promise.reject(this.listError);
    return Promise.resolve(this.listResult);
  }

  getResourceCounts(): Promise<Record<string, number>> {
    return Promise.resolve(this.counts);
  }

  startResourceWatch(resourceType: string, namespace: string): Promise<void> {
    this.watchStarted = { resourceType, namespace };
    return Promise.resolve();
  }

  stopResourceWatch(): Promise<void> {
    this.watchStopCount++;
    this.watchStarted = null;
    return Promise.resolve();
  }

  onWatchEvent(cb: (payload: WatchEventPayload) => void): Promise<Unsubscribe> {
    this._watchCb = cb;
    return Promise.resolve(() => {
      this._watchCb = null;
    });
  }

  // ── Cluster / contexts ──
  getContexts(): Promise<string[]> {
    return Promise.resolve([]);
  }
  getCurrentContext(): Promise<string> {
    return Promise.resolve(this.currentContext ?? "");
  }
  switchContext(context: string): Promise<void> {
    this.currentContext = context;
    return Promise.resolve();
  }
  getNamespaces(): Promise<string[]> {
    return Promise.resolve([]);
  }

  // ── Transient teardown ──
  stopLogStream(): Promise<void> {
    return Promise.resolve();
  }
  stopTerminalExec(): Promise<void> {
    return Promise.resolve();
  }

  // ── Port forwards ──
  startPortForward(args: PortForwardStartArgs): Promise<PortForwardStartResult> {
    return Promise.resolve({ session_id: args.sessionId, local_port: args.localPort });
  }
  stopPortForward(): Promise<void> {
    return Promise.resolve();
  }
  onPortForwardClosed(): Promise<Unsubscribe> {
    return Promise.resolve(() => {});
  }

  // ── CRDs ──
  discoverCrds(): Promise<CrdGroup[]> {
    return Promise.resolve([]);
  }
  listCrdResources(_args: CrdListArgs): Promise<CrdResourceList> {
    return Promise.resolve({ items: [], columns: [] });
  }
  getCrdCounts(_crds: CrdInfo[]): Promise<Record<string, number>> {
    return Promise.resolve({});
  }
}
