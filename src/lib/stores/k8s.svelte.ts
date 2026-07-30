import type { Resource, ResourceList, ConnectionStatus, PortForwardInfo, CrdGroup, CrdInfo, CrdResourceList } from "../types/index.js";
import { settingsStore } from "./settings.svelte";
import { toastStore } from "./toast.svelte.js";
import { K8sStoreLogic, COUNTABLE_RESOURCE_TYPES } from "./k8s.logic.js";
import type { KubeIo, Unsubscribe } from "./k8s.io.js";
import { TauriKubeIo } from "./k8s.io.tauri.js";
import { unshadowState } from "./_unshadow.js";

export type { WatchEvent, NavigationEntry } from "./k8s.logic.js";
export { COUNTABLE_RESOURCE_TYPES } from "./k8s.logic.js";

class K8sStore extends K8sStoreLogic {
  // Override all state properties with $state runes for Svelte 5 reactivity
  override contexts = $state<string[]>([]);
  override currentContext = $state<string>("");
  override namespaces = $state<string[]>([]);
  override currentNamespace = $state<string>("default");
  // $state.raw, not deep $state: k8s payloads are immutable snapshots from the
  // backend — replaced wholesale (never field-mutated by the UI), so per-field
  // reactivity is pure overhead. Deep-proxying every list would allocate tens of
  // thousands of Proxy objects per load at 1-5k items. Every writer below
  // reassigns `resources` to a fresh object, so reactivity still fires; the
  // watch-flush MUST build a new items array (never mutate the stored one).
  override resources = $state.raw<ResourceList>({ items: [], resource_type: "" });
  override selectedResource = $state<Resource | null>(null);
  override selectedResourceType = $state<string>("pods");
  override pendingResourceType = $state<string>("");

  override connectionStatus = $state<ConnectionStatus>("disconnected");
  override isSwitchingContext = $state<boolean>(false);
  override switchingContextTo = $state<string | null>(null);
  override isLoading = $state<boolean>(false);
  override error = $state<string | null>(null);
  override contextsLoadError = $state<string | null>(null);
  override namespacesLoadError = $state<string | null>(null);
  override resourceCounts = $state<Record<string, number>>({});
  override portForwards = $state<PortForwardInfo[]>([]);
  override ageTick = $state(0);

  // CRD state
  override crdGroups = $state<CrdGroup[]>([]);
  // $state.raw: CRD payloads are arbitrary, often-large JSON shown in a
  // non-virtualized table — deep-proxying them is the worst offender. Replaced
  // wholesale, never field-mutated, so raw is both faster and correct.
  override crdResources = $state.raw<CrdResourceList>({ items: [], columns: [] });
  override crdLoading = $state<boolean>(false);
  override crdError = $state<string | null>(null);
  override crdCounts = $state<Record<string, number>>({});
  override selectedCrd = $state<CrdInfo | null>(null);

  // Port-forward listener slot (still Tauri/browser-bound; the resource-watch
  // lifecycle moved to K8sStoreLogic behind the KubeIo port).
  private _pfUnlisten: Unsubscribe | null = null;

  constructor(io: KubeIo = new TauriKubeIo()) {
    super(io);
    unshadowState(this);
  }

  private async _stopAllPortForwards(): Promise<void> {
    const active = [...this.portForwards];
    await Promise.allSettled(
      active.map((pf) => this.io.stopPortForward(pf.session_id))
    );
    this.portForwards = [];
  }

  private async _stopTransientSessions(): Promise<void> {
    await this._stopWatch();
    await Promise.allSettled([
      this.io.stopLogStream(),
      this.io.stopTerminalExec(),
      this._stopAllPortForwards(),
    ]);
  }

  async loadContexts(): Promise<void> {
    try {
      this.contextsLoadError = null;
      this.error = null;
      this.connectionStatus = "connecting";
      const result = await this.io.getContexts();
      this.contexts = result;
      if (result.length > 0 && !this.currentContext) {
        try {
          this.currentContext = await this.io.getCurrentContext();
        } catch {
          this.currentContext = result[0];
        }
      }
      this.connectionStatus = "connected";
    } catch (err) {
      const message = `Failed to load contexts: ${err}`;
      this.contextsLoadError = message;
      this.error = message;
      this.connectionStatus = "error";
    }
  }

  async loadNamespaces(scopeGeneration = this._scopeGeneration): Promise<void> {
    try {
      this.namespacesLoadError = null;
      this.error = null;
      const result = await this.io.getNamespaces();
      if (scopeGeneration !== this._scopeGeneration) return;
      this.namespaces = result;
    } catch (err) {
      if (scopeGeneration !== this._scopeGeneration) return;
      const message = `Failed to load namespaces: ${err}`;
      this.namespacesLoadError = message;
      this.error = message;
    }
  }

  async switchContext(context: string): Promise<void> {
    const scopeGeneration = this._beginScopeChange();
    this.isSwitchingContext = true;
    this.switchingContextTo = context;
    try {
      await this._stopTransientSessions();
      if (scopeGeneration !== this._scopeGeneration) return;

      this.connectionStatus = "connecting";
      await this.io.switchContext(context);
      if (scopeGeneration !== this._scopeGeneration) return;

      this._resetVisibleState({ clearNamespaces: true });
      this.currentContext = context;
      await this.loadNamespaces(scopeGeneration);
      if (scopeGeneration !== this._scopeGeneration) return;

      const fallbackNamespace = this.namespaces.includes(this.currentNamespace)
        ? this.currentNamespace
        : this.namespaces.includes("default")
          ? "default"
          : (this.namespaces[0] ?? "");
      this.currentNamespace = fallbackNamespace;

      await this.loadResources(this.selectedResourceType, scopeGeneration);
      if (scopeGeneration !== this._scopeGeneration) return;
      this.connectionStatus = "connected";
      this._persistSelection();
      // Refresh sidebar counts in background for new context
      void this.loadAllResourceCounts(scopeGeneration);
    } catch (err) {
      if (scopeGeneration !== this._scopeGeneration) return;
      this.error = `Failed to switch context: ${err}`;
      this.connectionStatus = "error";
    } finally {
      if (scopeGeneration === this._scopeGeneration) {
        this.isSwitchingContext = false;
        this.switchingContextTo = null;
      }
    }
  }

  async switchNamespace(namespace: string): Promise<void> {
    const scopeGeneration = this._beginScopeChange();
    try {
      await this._stopTransientSessions();
      if (scopeGeneration !== this._scopeGeneration) return;

      this.currentNamespace = namespace;
      this._resetVisibleState({ keepNamespace: namespace });
      await this.loadResources(this.selectedResourceType, scopeGeneration);
      if (scopeGeneration !== this._scopeGeneration) return;
      this._persistSelection();
      // Refresh sidebar counts in background for new namespace
      void this.loadAllResourceCounts(scopeGeneration);
    } catch (err) {
      if (scopeGeneration !== this._scopeGeneration) return;
      this.error = `Failed to switch namespace: ${err}`;
    }
  }

  /** @deprecated Use openRelatedResourceTab() or openResourceDetail() instead */
  async navigateToRelated(resourceType: string, name: string, namespace?: string): Promise<void> {
    // Push current state
    if (this.selectedResource) {
      this._navHistory.push({
        resourceType: this.selectedResourceType,
        resource: this.selectedResource,
      });
    }

    await this.loadResources(resourceType);

    // Find the target resource by name (and namespace if provided)
    const target = this.resources.items.find(
      (r) => r.metadata.name === name && (!namespace || r.metadata.namespace === namespace)
    );
    this.selectedResource = target ?? null;
  }

  /** Go back to the previous detail view from the navigation history. Returns true if navigated back. */
  override navigateBack(): boolean {
    const entry = this._navHistory.pop();
    if (!entry) return false;

    this.setResourceType(entry.resourceType);
    this.selectedResource = entry.resource;
    // Reload resources for the previous type in background
    this._listResources(entry.resourceType).then((result) => {
      this.resources = { items: result.items, resource_type: entry.resourceType };
      this._setCount(entry.resourceType, result.items.length);
      this._startWatch(entry.resourceType, this.currentNamespace);
      // Re-find the resource in case it was updated
      const updated = result.items.find((r) => r.metadata.uid === entry.resource.metadata.uid);
      if (updated) this.selectedResource = updated;
    }).catch(() => {
      // keep the stale resource for display
    });

    return true;
  }

  /** Navigate back to a specific breadcrumb level, popping everything after it. */
  override navigateToHistoryIndex(index: number): void {
    if (index < 0 || index >= this._navHistory.length) return;
    const entry = this._navHistory[index];
    this._navHistory = this._navHistory.slice(0, index);
    this.setResourceType(entry.resourceType);
    this.selectedResource = entry.resource;
    const expectedType = entry.resourceType;
    this._listResources(expectedType).then((result) => {
      if (this.selectedResourceType !== expectedType) return;
      this.resources = { items: result.items, resource_type: expectedType };
      this._setCount(expectedType, result.items.length);
      this._startWatch(expectedType, this.currentNamespace);
      const updated = result.items.find((r) => r.metadata.uid === entry.resource.metadata.uid);
      if (updated) this.selectedResource = updated;
    }).catch(() => {});
  }

  async refreshResources(): Promise<void> {
    await this.loadResources(this.selectedResourceType);
  }

  async resetForUserSwitch(): Promise<void> {
    this._beginScopeChange();
    this.isSwitchingContext = false;
    this.switchingContextTo = null;
    await this._stopTransientSessions();
    this.setResourceType("pods");
    this._resetVisibleState({
      clearContexts: true,
      clearNamespaces: true,
      keepNamespace: "default",
    });
    settingsStore.updateConnection("", "default");
  }

  /** Load counts for all resource types via a single batch Tauri command. */
  async loadAllResourceCounts(scopeGeneration = this._scopeGeneration): Promise<void> {
    const gen = ++this._countGeneration;
    const namespace = this.currentNamespace;
    try {
      const counts = await this.io.getResourceCounts(COUNTABLE_RESOURCE_TYPES, namespace);
      // Discard stale results if namespace/context changed while in-flight
      if (gen !== this._countGeneration || scopeGeneration !== this._scopeGeneration) return;
      this.resourceCounts = { ...this.resourceCounts, ...counts };
    } catch {
      // silently ignore - sidebar badges are optional
    }
  }

  async restoreConnection(context: string | undefined, namespace: string | undefined): Promise<void> {
    try {
      if (context && this.contexts.includes(context) && context !== this.currentContext) {
        this.connectionStatus = "connecting";
        await this.io.switchContext(context);
        this.currentContext = context;
        this.connectionStatus = "connected";
      }
      if (namespace) {
        this.currentNamespace = namespace;
      }
    } catch (err) {
      this.error = `Failed to restore connection: ${err}`;
      this.connectionStatus = "error";
    }
  }

  private _persistSelection(): void {
    settingsStore.updateConnection(this.currentContext, this.currentNamespace);
  }

  // requestAnimationFrame coalesces a burst of watch events into one flush per
  // frame. The base K8sStoreLogic uses a microtask by default (bun-testable);
  // in the browser we want the real frame-batched behaviour.
  protected override _scheduleFlush(flush: () => void): void {
    requestAnimationFrame(flush);
  }

  private async _ensurePortForwardListener(): Promise<void> {
    if (this._pfUnlisten) return;
    this._pfUnlisten = await this.io.onPortForwardClosed((sessionId) => {
      const pf = this.portForwards.find((p) => p.session_id === sessionId);
      if (pf) {
        this.portForwards = this.portForwards.filter((p) => p.session_id !== sessionId);
        toastStore.warning(
          "Port forward stopped",
          `Forward to ${pf.pod_name}:${pf.container_port} ended unexpectedly`,
        );
      }
    });
  }

  async addPortForward(info: PortForwardInfo): Promise<void> {
    await this._ensurePortForwardListener();
    try {
      const result = await this.io.startPortForward({
        podName: info.pod_name,
        namespace: info.namespace,
        containerPort: info.container_port,
        localPort: info.local_port,
        sessionId: info.session_id,
      });
      this.portForwards = [
        ...this.portForwards,
        { ...info, local_port: result.local_port, session_id: result.session_id },
      ];
    } catch (err) {
      this.error = `Failed to start port forward: ${err}`;
    }
  }

  async removePortForward(sessionId: string): Promise<void> {
    try {
      await this.io.stopPortForward(sessionId);
    } catch {
      // ignore stop errors (session may already be gone)
    }
    this.portForwards = this.portForwards.filter((pf) => pf.session_id !== sessionId);
  }

  // =========================================================================
  // CRD Discovery & Browsing
  // =========================================================================

  async discoverCrds(): Promise<void> {
    const scopeGeneration = this._scopeGeneration;
    this.crdLoading = true;
    this.crdError = null;
    try {
      const groups = await this.io.discoverCrds();
      if (scopeGeneration !== this._scopeGeneration) return;
      this.crdGroups = groups;
    } catch (e) {
      if (scopeGeneration !== this._scopeGeneration) return;
      this.crdError = String(e);
      // Only reassign if non-empty — a new `[]` reference would invalidate
      // reactive readers (e.g. Sidebar's discovery effect) and retrigger
      // discoverCrds, producing an infinite loop when the API keeps failing.
      if (this.crdGroups.length > 0) this.crdGroups = [];
    } finally {
      this.crdLoading = false;
    }
  }

  async loadCrdResources(crd: CrdInfo): Promise<void> {
    const scopeGeneration = this._scopeGeneration;
    this.selectedCrd = crd;
    this.crdResources = { items: [], columns: [] };
    this.isLoading = true;
    try {
      const result = await this.io.listCrdResources({
        group: crd.group,
        version: crd.version,
        kind: crd.kind,
        plural: crd.plural,
        scope: crd.scope,
        namespace: crd.scope === "Namespaced" ? this.currentNamespace : null,
      });
      if (scopeGeneration !== this._scopeGeneration) return;
      this.crdResources = result;
    } catch (e) {
      if (scopeGeneration !== this._scopeGeneration) return;
      this.crdResources = { items: [], columns: [] };
      toastStore.error("Failed to load CRD resources", String(e));
    } finally {
      this.isLoading = false;
    }
  }

  async loadCrdCounts(crds: CrdInfo[]): Promise<void> {
    if (crds.length === 0) return;
    try {
      const counts = await this.io.getCrdCounts(crds, this.currentNamespace);
      this.crdCounts = { ...this.crdCounts, ...counts };
    } catch {
      // Silently fail — counts are non-essential
    }
  }
}

export type { K8sStore };
export const k8sStore = new K8sStore();
