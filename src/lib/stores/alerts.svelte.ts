// Desktop alerts — the Svelte store. Polls the watched resources of the
// connected context (alerts.logic.ts does the judging) and surfaces alerts as
// toasts plus native notifications, so a CrashLoopBackOff in a watched
// Deployment reaches the user while they are in another window.

import { invoke } from "$lib/ipc/core";
import type { Event as K8sEvent, Resource, WatchedResource } from "$lib/types";
import { kindToResourceType } from "$lib/utils/related-resources";
import { k8sStore } from "./k8s.svelte";
import { settingsStore } from "./settings.svelte";
import { toastStore } from "./toast.svelte";
import { AlertMonitor, type Alert } from "./alerts.logic";

/** How often every watched resource is re-read. */
export const ALERT_POLL_MS = 20_000;
const RECENT_LIMIT = 50;

class AlertStore {
  /** Newest first, capped. */
  recent = $state<Alert[]>([]);
  /** True while a poll is running. */
  polling = $state(false);
  /** Unread alerts since the user last opened the list. */
  unread = $state(0);

  private readonly monitor = new AlertMonitor({
    getResource: (w) =>
      invoke<Resource | null>("get_resource", { kind: w.kind, name: w.name, namespace: w.namespace ?? "" }).catch((err) => {
        // 404 = gone (an alert); anything else = transient (retry next tick).
        const msg = String(err);
        if (/not found|404/i.test(msg)) return null;
        throw err;
      }),
    getEvents: (w) =>
      invoke<K8sEvent[]>("get_resource_events", { resourceType: w.resourceType, name: w.name, namespace: w.namespace ?? "" }),
  });
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.timer = setInterval(() => void this.tick(), ALERT_POLL_MS);
  }

  /** Watched resources for the connected context. */
  get watched(): WatchedResource[] {
    const ctx = k8sStore.currentContext;
    return settingsStore.watchedResources.filter((w) => w.context === ctx);
  }

  isWatched(resource: Resource): boolean {
    return !!settingsStore.findWatched(k8sStore.currentContext, resource.kind, resource.metadata.name, resource.metadata.namespace);
  }

  /** Start watching; the first poll runs right away and reports the baseline. */
  watch(resource: Resource): void {
    const w: WatchedResource = {
      id: crypto.randomUUID(),
      context: k8sStore.currentContext,
      kind: resource.kind,
      resourceType: kindToResourceType(resource.kind),
      name: resource.metadata.name,
      namespace: resource.metadata.namespace,
    };
    settingsStore.watchResource(w);
    void this.monitor.poll(w).then((alerts) => this.report(alerts));
  }

  unwatch(resource: Resource): void {
    const w = settingsStore.findWatched(k8sStore.currentContext, resource.kind, resource.metadata.name, resource.metadata.namespace);
    if (!w) return;
    settingsStore.unwatchResource(w.id);
    this.monitor.forget(w.id);
  }

  unwatchById(id: string): void {
    settingsStore.unwatchResource(id);
    this.monitor.forget(id);
  }

  markRead(): void {
    this.unread = 0;
  }

  async tick(): Promise<void> {
    if (this.polling || k8sStore.connectionStatus !== "connected") return;
    const watched = this.watched;
    this.monitor.retain(watched);
    if (watched.length === 0) return;
    this.polling = true;
    try {
      this.report(await this.monitor.tick(watched));
    } finally {
      this.polling = false;
    }
  }

  private report(alerts: Alert[]): void {
    if (alerts.length === 0) return;
    this.recent = [...alerts.slice().reverse(), ...this.recent].slice(0, RECENT_LIMIT);
    this.unread += alerts.length;
    for (const a of alerts) {
      if (a.level === "error") toastStore.error(a.title, a.body);
      else if (a.level === "warning") toastStore.warning(a.title, a.body);
      else toastStore.info(a.title, a.body);
      // Baseline "Watching…" is feedback for a click the user just made;
      // everything else may arrive while they are elsewhere.
      if (!a.title.startsWith("Watching ")) notifyDesktop(a);
    }
  }
}

/** Native OS notification via the renderer's Notification API (Electron routes
 *  it to the platform notifier). Silently skipped where unavailable or denied. */
function notifyDesktop(a: Alert): void {
  try {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "denied") return;
    if (Notification.permission !== "granted") {
      void Notification.requestPermission().then((p) => {
        if (p === "granted") show(a);
      });
      return;
    }
    show(a);
  } catch {
    // notifications are best effort
  }
}

function show(a: Alert): void {
  const n = new Notification(a.title, { body: a.body, tag: `kdash-${a.watchedId}-${a.title}`, silent: a.level === "info" });
  n.onclick = () => window.focus();
}

export const alertStore = new AlertStore();
