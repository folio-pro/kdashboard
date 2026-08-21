// Range queries against the optional Prometheus, as reactive state.
//
// Two panels chart history the same way: fire a handful of range queries for
// the object on screen, then show either the curves, "no Prometheus
// configured", or the failure. That is three pieces of state, a cancellation
// flag and a user-facing sentence — written once here rather than once per
// panel, so the copy cannot drift and a panel cannot forget the cancel.

import { metricsStore } from "./metrics.svelte";
import type { PrometheusSample } from "$lib/types";

/** Shown when no Prometheus URL is set. One definition, several panels. */
export const PROMETHEUS_HINT =
  "Set a Prometheus URL in Settings → Kubernetes to chart the last hour.";

export interface PrometheusHistory {
  /** One sample list per query, in the order the queries were given. */
  readonly series: PrometheusSample[][];
  /** False once a response reports no Prometheus is configured. */
  readonly configured: boolean;
  /** A failed query, for the panel to show instead of the chart. */
  readonly error: string;
  /** True once any query has returned at least one sample. */
  readonly hasSamples: boolean;
}

/**
 * Run `queries()` whenever its inputs change and expose the result reactively.
 * Return null from `queries` for "nothing to chart here" — the panel keeps
 * whatever it had rather than firing a query it cannot use.
 *
 * Must be called during component initialisation: it owns an `$effect`.
 */
export function prometheusHistory(
  queries: () => string[] | null,
  minutes = 60,
): PrometheusHistory {
  // $state.raw: sample lists are snapshots replaced wholesale, and proxying
  // a few hundred points per refresh buys nothing.
  let series = $state.raw<PrometheusSample[][]>([]);
  let configured = $state(true);
  let error = $state("");

  $effect(() => {
    const wanted = queries();
    if (!wanted) return;
    let cancelled = false;

    Promise.all(wanted.map((q) => metricsStore.queryRange(q, minutes)))
      .then((results) => {
        if (cancelled) return;
        configured = results[0]?.configured ?? false;
        error = "";
        series = results.map((r) => r.series[0]?.samples ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        error = String(err);
        series = [];
      });

    return () => {
      cancelled = true;
    };
  });

  return {
    get series() {
      return series;
    },
    get configured() {
      return configured;
    },
    get error() {
      return error;
    },
    get hasSamples() {
      return series.some((s) => s.length > 0);
    },
  };
}
