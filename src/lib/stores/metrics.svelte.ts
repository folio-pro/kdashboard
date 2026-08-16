import { invoke } from "$lib/ipc/core";
import { unshadowState } from "./_unshadow.js";
import type { PodMetricsResult, PodUsageInfo, PrometheusResult } from "$lib/types";
import { MetricsStoreLogic, POD_METRICS_TTL_MS } from "./metrics.logic";

class MetricsStore extends MetricsStoreLogic {
  // $state.raw: replaced wholesale every poll (applyPodUsage builds a fresh
  // map); deep-proxying thousands of per-pod entries buys nothing.
  override podUsage = $state.raw<Record<string, PodUsageInfo>>({});
  override podMetricsAvailable = $state(true);
  override unavailableReason = $state("");

  constructor() {
    super();
    unshadowState(this);
  }

  /**
   * Refresh pod usage for a namespace ("" / null = all namespaces). Cheap to
   * call from an effect: it self-throttles to POD_METRICS_TTL_MS and skips
   * entirely once the cluster is known to have no metrics-server.
   */
  async loadPodMetrics(namespace: string | null, force = false): Promise<void> {
    if (this._loading && !force) return;
    if (!force && !this.isStale(Date.now())) return;
    this._loading = true;
    // A forced load can overtake an in-flight one for the previous namespace;
    // stamping the request lets the late response be dropped instead of
    // repopulating the cache with the wrong namespace's pods.
    const requestId = ++this._requestId;
    try {
      const result = await invoke<PodMetricsResult>("get_pod_metrics", { namespace });
      if (requestId !== this._requestId) return;
      this.podMetricsAvailable = result.available;
      this.unavailableReason = result.reason;
      this.applyPodUsage(result.pods, Date.now());
    } catch (err) {
      // A hard failure (no connection) leaves the previous values in place —
      // the table keeps showing the last known usage rather than blanking.
      if (requestId === this._requestId) this.unavailableReason = String(err);
    } finally {
      if (requestId === this._requestId) this._loading = false;
    }
  }

  /** Run a Prometheus range query; `configured: false` when no URL is set. */
  async queryRange(query: string, minutes = 60): Promise<PrometheusResult> {
    return invoke<PrometheusResult>("query_prometheus_range", { query, minutes });
  }

  override reset(): void {
    super.reset();
    this.podUsage = {};
    this.podMetricsAvailable = true;
    this.unavailableReason = "";
  }
}

export const metricsStore = new MetricsStore();
export { POD_METRICS_TTL_MS };
