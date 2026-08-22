// Saved port forwards — the Svelte store. Behaviour lives in
// port-forwards.logic.ts (SavedForwardKeeper, resolveForward); this file wires
// it to the k8s store (sessions, the closed channel, context switches), the
// settings store (persistence) and IPC (target resolution).

import { invoke } from "$lib/ipc/core";
import type { PortForwardInfo, Resource, ResourceList, SavedPortForward } from "$lib/types";
import { k8sStore } from "./k8s.svelte";
import { settingsStore } from "./settings.svelte";
import { toastStore } from "./toast.svelte";
import {
  SavedForwardKeeper,
  describeTarget,
  inferForwardTarget,
  resolveForward,
  sameForward,
  savedForSession,
  savedForwardsFor,
  savedFromActive,
  type SavedForwardState,
} from "./port-forwards.logic";
import type { ForwardTargetKind } from "$lib/types";

const IDLE: SavedForwardState = { kind: "idle" };

class PortForwardStore {
  /** Live state per saved-forward id. Replaced wholesale so `$state` notices. */
  states = $state<Record<string, SavedForwardState>>({});

  private readonly keeper = new SavedForwardKeeper({
    start: (saved) => this._startSession(saved),
    stop: (sessionId) => k8sStore.removePortForward(sessionId),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    onState: (id, state) => {
      const next = { ...this.states };
      if (state.kind === "idle") delete next[id];
      else next[id] = state;
      this.states = next;
    },
  });

  constructor() {
    k8sStore.onPortForwardClosed = (pf) => {
      const saved = savedForSession(settingsStore.savedPortForwards, pf);
      const id = this.keeper.sessionClosed(pf.session_id, saved);
      if (!id || !saved) return false;
      toastStore.info(
        "Reconnecting port forward",
        `${describeTarget(saved)} → localhost:${saved.local_port} dropped; retrying.`,
      );
      return true;
    };
    k8sStore.onContextConnected = (context) => {
      // Sessions died with the old context (the k8s store stops them all);
      // forget their state and bring up whatever this context wants running.
      this.keeper.reset();
      void this.autoStart(context);
    };
  }

  /** Saved forwards for the connected context. */
  get saved(): SavedPortForward[] {
    return savedForwardsFor(settingsStore.savedPortForwards, k8sStore.currentContext);
  }

  stateOf(id: string): SavedForwardState {
    return this.states[id] ?? IDLE;
  }

  /** The saved forward an active session belongs to, if any. */
  savedFor(pf: Pick<PortForwardInfo, "saved_id">): SavedPortForward | undefined {
    return savedForSession(settingsStore.savedPortForwards, pf);
  }

  /** Is there a saved forward equivalent to this active session? */
  findEquivalent(pf: PortForwardInfo, target: { kind: ForwardTargetKind; name: string }): SavedPortForward | undefined {
    const probe = savedFromActive(pf, k8sStore.currentContext, target, "probe");
    return this.saved.find((s) => sameForward(s, probe));
  }

  /**
   * Remember an active session as a saved forward and adopt the session, so a
   * later drop reconnects it. `target` defaults to the pod itself; callers
   * with the pod object in hand pass `inferForwardTarget(pod)` so the forward
   * follows the workload across restarts.
   */
  save(pf: PortForwardInfo, target?: { kind: ForwardTargetKind; name: string }): SavedPortForward {
    const t = target ?? { kind: "Pod", name: pf.pod_name };
    const existing = this.findEquivalent(pf, t);
    const saved = existing ?? savedFromActive(pf, k8sStore.currentContext, t, crypto.randomUUID());
    if (!existing) settingsStore.upsertSavedPortForward(saved);
    k8sStore.adoptPortForward(pf.session_id, saved.id);
    this.keeper.adopt(saved.id, pf.session_id, pf.pod_name);
    return saved;
  }

  saveFromPod(pf: PortForwardInfo, pod: Pick<Resource, "metadata">): SavedPortForward {
    return this.save(pf, inferForwardTarget(pod));
  }

  /** Drop the saved entry. A running session keeps running (now unsaved). */
  forget(id: string): void {
    this.keeper.release(id);
    k8sStore.adoptPortForward(this._sessionOf(id), undefined);
    settingsStore.removeSavedPortForward(id);
  }

  setAutoStart(id: string, autoStart: boolean): void {
    const saved = settingsStore.savedPortForwards.find((s) => s.id === id);
    if (saved) settingsStore.upsertSavedPortForward({ ...saved, auto_start: autoStart });
  }

  async start(saved: SavedPortForward): Promise<void> {
    await this.keeper.start(saved);
  }

  async stop(id: string): Promise<void> {
    await this.keeper.stop(id);
  }

  /** Start every auto-start forward saved for `context`. */
  async autoStart(context: string): Promise<void> {
    const wanted = savedForwardsFor(settingsStore.savedPortForwards, context).filter((s) => s.auto_start);
    await Promise.allSettled(wanted.map((s) => this.keeper.start(s)));
  }

  private _sessionOf(id: string): string | undefined {
    const st = this.stateOf(id);
    return st.kind === "active" ? st.sessionId : undefined;
  }

  private async _startSession(saved: SavedPortForward): Promise<{ sessionId: string; podName: string }> {
    const { podName, containerPort } = await resolveForward(saved, {
      getResource: (kind, name, namespace) =>
        invoke<Resource | null>("get_resource", { kind, name, namespace }).catch(() => null),
      listPodsBySelector: (namespace, selector) =>
        invoke<ResourceList>("list_pods_by_selector", { namespace, selector }).then((r) => r.items),
    });
    const sessionId = crypto.randomUUID();
    await k8sStore.startPortForward({
      session_id: sessionId,
      pod_name: podName,
      namespace: saved.namespace,
      container_port: containerPort,
      local_port: saved.local_port,
      saved_id: saved.id,
    });
    return { sessionId, podName };
  }
}

export const portForwardStore = new PortForwardStore();
