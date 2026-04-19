import { invoke } from "@tauri-apps/api/core";
import { AsyncLoadStore } from "./async-load.svelte";
import { unshadowState } from "./_unshadow.js";
import type { CostOverview, NodeCostInfo, NodeMetricsInfo } from "$lib/types";
import { METRICS_TTL_MS } from "./cost.logic";

class CostStore extends AsyncLoadStore<CostOverview> {
  /** Alias for readability in templates */
  get overview() { return this.data; }

  /** Node costs keyed by node name for O(1) lookup from table rows */
  nodeCosts = $state<Record<string, NodeCostInfo>>({});
  private _nodeLoading = false;

  nodeMetrics = $state<Record<string, NodeMetricsInfo>>({});
  private _metricsLoading = false;
  private _metricsFetchedAt = 0;

  constructor() {
    super();
    unshadowState(this);
  }

  async loadCostOverview(namespace: string | null): Promise<void> {
    await this._load("get_cost_overview", namespace);
  }

  async loadNodeCosts(): Promise<void> {
    if (Object.keys(this.nodeCosts).length > 0 || this._nodeLoading) return;
    this._nodeLoading = true;
    try {
      const costs = await invoke<NodeCostInfo[]>("get_node_costs");
      const map: Record<string, NodeCostInfo> = {};
      for (const c of costs) {
        map[c.node_name] = c;
      }
      this.nodeCosts = map;
    } catch {
      // Non-critical — table just won't show prices
    } finally {
      this._nodeLoading = false;
    }
  }

  async loadNodeMetrics(): Promise<void> {
    if (this._metricsLoading) return;
    if (Date.now() - this._metricsFetchedAt < METRICS_TTL_MS) return;
    this._metricsLoading = true;
    const loadId = this._loadId;
    try {
      const metrics = await invoke<NodeMetricsInfo[]>("get_node_metrics");
      if (loadId !== this._loadId) return;
      const map: Record<string, NodeMetricsInfo> = {};
      for (const m of metrics) {
        map[m.node_name] = m;
      }
      this.nodeMetrics = map;
      this._metricsFetchedAt = Date.now();
    } catch {
      // metrics-server may not be installed — silently ignore
    } finally {
      this._metricsLoading = false;
    }
  }

  getNodeCost(nodeName: string): NodeCostInfo | undefined {
    return this.nodeCosts[nodeName];
  }

  getNodeMetrics(nodeName: string): NodeMetricsInfo | undefined {
    return this.nodeMetrics[nodeName];
  }

  override reset(): void {
    super.reset();
    this.nodeCosts = {};
    this._nodeLoading = false;
    this.nodeMetrics = {};
    this._metricsLoading = false;
    this._metricsFetchedAt = 0;
  }
}

export const costStore = new CostStore();
