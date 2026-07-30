import type {
  Resource,
  ResourceList,
  CrdGroup,
  CrdInfo,
  CrdResourceList,
} from "../types/index.js";
import type { WatchEvent } from "./k8s.logic.js";

/**
 * The seam between the k8s store's orchestration and the Kubernetes backend.
 *
 * The store speaks Kubernetes (list these resources, watch that type) — never
 * Tauri IPC command strings. TauriKubeIo maps this domain surface onto
 * `invoke`/`listen`; a fake implementation lets the whole load → cache → watch
 * → reconcile state machine be exercised in bun test without a real cluster.
 *
 * Two adapters (real + fake) make this a real seam, not a hypothetical one.
 */

/** Undo a subscription made via onWatchEvent / onPortForwardClosed. */
export type Unsubscribe = () => void;

/** The backend may deliver a single watch event or a coalesced batch. */
export type WatchEventPayload = WatchEvent | WatchEvent[];

export interface PortForwardStartArgs {
  podName: string;
  namespace: string;
  containerPort: number;
  localPort: number;
  sessionId: string;
}

export interface PortForwardStartResult {
  session_id: string;
  local_port: number;
}

export interface CrdListArgs {
  group: string;
  version: string;
  kind: string;
  plural: string;
  scope: string;
  /** null for cluster-scoped CRDs. */
  namespace: string | null;
}

export interface KubeIo {
  // ── Cluster / contexts ──
  getContexts(): Promise<string[]>;
  getCurrentContext(): Promise<string>;
  switchContext(context: string): Promise<void>;
  getNamespaces(): Promise<string[]>;

  // ── Resources ──
  listResources(resourceType: string, namespace: string): Promise<ResourceList>;
  getResourceCounts(
    resourceTypes: readonly string[],
    namespace: string,
  ): Promise<Record<string, number>>;

  // ── Watch ──
  startResourceWatch(resourceType: string, namespace: string): Promise<void>;
  stopResourceWatch(): Promise<void>;
  onWatchEvent(cb: (payload: WatchEventPayload) => void): Promise<Unsubscribe>;

  // ── Transient session teardown ──
  stopLogStream(): Promise<void>;
  stopTerminalExec(): Promise<void>;

  // ── Port forwards ──
  startPortForward(args: PortForwardStartArgs): Promise<PortForwardStartResult>;
  stopPortForward(sessionId: string): Promise<void>;
  onPortForwardClosed(cb: (sessionId: string) => void): Promise<Unsubscribe>;

  // ── CRDs ──
  discoverCrds(): Promise<CrdGroup[]>;
  listCrdResources(args: CrdListArgs): Promise<CrdResourceList>;
  getCrdCounts(
    crds: CrdInfo[],
    namespace: string,
  ): Promise<Record<string, number>>;
}

export type { Resource };
