import { AsyncLoadStoreLogic } from "./async-load.logic";
import type { CostOverview, NodeCostInfo, NodeMetricsInfo } from "$lib/types";

/** Metrics are considered fresh for 30 seconds */
export const METRICS_TTL_MS = 30_000;

export class CostStoreLogic extends AsyncLoadStoreLogic<CostOverview> {
  /** Alias for readability in templates */
  get overview() { return this.data; }

  /** Node costs keyed by node name for O(1) lookup from table rows */
  nodeCosts: Record<string, NodeCostInfo> = {};
  _nodeLoading = false;

  nodeMetrics: Record<string, NodeMetricsInfo> = {};
  _metricsLoading = false;
  _metricsFetchedAt = 0;

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
