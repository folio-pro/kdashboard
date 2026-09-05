import { test, expect, describe } from "bun:test";

import type { Resource } from "$lib/types";
import {
  UNKNOWN,
  autoscalerFlavor,
  autoscalerSummary,
  formatReplicas,
  formatTargets,
} from "./autoscaler";

function res(kind: string, spec: Record<string, unknown>, status: Record<string, unknown> = {}): Resource {
  return {
    kind,
    api_version: "v2",
    metadata: {
      name: "web",
      namespace: "prod",
      uid: "u1",
      creation_timestamp: "",
      labels: {},
      annotations: {},
      owner_references: [],
      resource_version: "1",
    },
    spec,
    status,
  };
}

describe("autoscalerFlavor", () => {
  test("resolves list types, plurals and kinds", () => {
    expect(autoscalerFlavor("hpa")).toBe("hpa");
    expect(autoscalerFlavor("HorizontalPodAutoscaler")).toBe("hpa");
    expect(autoscalerFlavor("verticalpodautoscalers")).toBe("vpa");
    expect(autoscalerFlavor("WatermarkPodAutoscaler")).toBe("wpa");
    expect(autoscalerFlavor("Deployment")).toBeNull();
  });
});

describe("hpa", () => {
  const hpa = (spec: Record<string, unknown>, status: Record<string, unknown> = {}) =>
    autoscalerSummary(res("HorizontalPodAutoscaler", spec, status), "hpa");

  test("reads the reference and the replica bounds", () => {
    const s = hpa(
      {
        scaleTargetRef: { kind: "Deployment", name: "api" },
        minReplicas: 2,
        maxReplicas: 10,
      },
      { currentReplicas: 3, desiredReplicas: 5 },
    );
    expect(s.reference).toBe("Deployment/api");
    expect(s.min).toBe(2);
    expect(s.max).toBe(10);
    expect(s.current).toBe(3);
    expect(s.desired).toBe(5);
    expect(formatReplicas(s)).toBe("3 → 5");
  });

  test("collapses replicas to one number when there is no gap", () => {
    const s = hpa({}, { currentReplicas: 4, desiredReplicas: 4 });
    expect(formatReplicas(s)).toBe("4");
  });

  test("pairs a utilization metric with its reading", () => {
    const s = hpa(
      {
        metrics: [
          { type: "Resource", resource: { name: "cpu", target: { type: "Utilization", averageUtilization: 80 } } },
        ],
      },
      {
        currentMetrics: [
          { type: "Resource", resource: { name: "cpu", current: { averageUtilization: 40 } } },
        ],
      },
    );
    expect(s.targets).toHaveLength(1);
    expect(s.targets[0]).toMatchObject({
      name: "cpu",
      source: "Resource",
      currentLabel: "40%",
      targetLabel: "80%",
      percent: 50,
    });
    expect(formatTargets(s)).toBe("cpu: 40%/80%");
  });

  test("pairs by identity, not by index, when a reading is missing", () => {
    // status drops the metric it cannot read, so index 0 of currentMetrics is
    // memory while index 0 of spec.metrics is cpu.
    const s = hpa(
      {
        metrics: [
          { type: "Resource", resource: { name: "cpu", target: { averageUtilization: 80 } } },
          { type: "Resource", resource: { name: "memory", target: { averageUtilization: 70 } } },
        ],
      },
      {
        currentMetrics: [
          { type: "Resource", resource: { name: "memory", current: { averageUtilization: 55 } } },
        ],
      },
    );
    expect(s.targets[0]).toMatchObject({ name: "cpu", currentLabel: UNKNOWN, percent: null });
    expect(s.targets[1]).toMatchObject({ name: "memory", currentLabel: "55%", percent: 79 });
    expect(formatTargets(s)).toBe("cpu: <unknown>/80%, memory: 55%/70%");
  });

  test("keeps the API's own quantity string for value targets", () => {
    const s = hpa(
      {
        metrics: [
          { type: "Pods", pods: { metric: { name: "packets" }, target: { averageValue: "800m" } } },
        ],
      },
      {
        currentMetrics: [
          { type: "Pods", pods: { metric: { name: "packets" }, current: { averageValue: "400m" } } },
        ],
      },
    );
    expect(s.targets[0]).toMatchObject({
      name: "packets",
      source: "Pods",
      currentLabel: "400m",
      targetLabel: "800m",
      percent: 50,
    });
  });

  test("names an External metric and an Object metric", () => {
    const s = hpa({
      metrics: [
        { type: "External", external: { metric: { name: "queue_depth" }, target: { value: "100" } } },
        {
          type: "Object",
          object: {
            metric: { name: "rps" },
            describedObject: { kind: "Ingress", name: "web" },
            target: { value: "1k" },
          },
        },
      ],
    });
    expect(s.targets.map((t) => `${t.source}:${t.name}`)).toEqual([
      "External:queue_depth",
      "Object:rps",
    ]);
  });

  test("names a ContainerResource metric by container and resource", () => {
    const s = hpa({
      metrics: [
        {
          type: "ContainerResource",
          containerResource: { name: "cpu", container: "app", target: { averageUtilization: 60 } },
        },
      ],
    });
    expect(s.targets[0]!.name).toBe("app/cpu");
  });

  test("falls back to the autoscaling/v1 single-metric shape", () => {
    const s = hpa(
      { targetCPUUtilizationPercentage: 50 },
      { currentCPUUtilizationPercentage: 25 },
    );
    expect(s.targets[0]).toMatchObject({ name: "cpu", currentLabel: "25%", targetLabel: "50%", percent: 50 });
  });

  test("surfaces an active ScalingLimited condition", () => {
    const s = hpa({}, {
      conditions: [
        { type: "AbleToScale", status: "True" },
        { type: "ScalingLimited", status: "True", reason: "TooManyReplicas" },
      ],
    });
    expect(s.limitedReason).toBe("TooManyReplicas");
    expect(s.conditions).toHaveLength(2);
  });

  test("ignores a ScalingLimited condition that is not active", () => {
    const s = hpa({}, { conditions: [{ type: "ScalingLimited", status: "False", reason: "DesiredWithinRange" }] });
    expect(s.limitedReason).toBeNull();
  });

  test("survives a status the controller has not written yet", () => {
    const s = hpa({ scaleTargetRef: { kind: "Deployment", name: "api" }, maxReplicas: 3 });
    expect(s.current).toBeNull();
    expect(s.targets).toEqual([]);
    expect(formatTargets(s)).toBe("-");
    expect(formatReplicas(s)).toBe("-");
  });
});

describe("wpa", () => {
  const wpa = (spec: Record<string, unknown>, status: Record<string, unknown> = {}) =>
    autoscalerSummary(res("WatermarkPodAutoscaler", spec, status), "wpa");

  test("reports the watermark band and fills towards the high one", () => {
    const s = wpa(
      {
        scaleTargetRef: { kind: "Deployment", name: "api" },
        minReplicas: 2,
        maxReplicas: 20,
        metrics: [
          {
            type: "External",
            external: { metricName: "nginx.net.request_per_s", highWatermark: "80", lowWatermark: "40" },
          },
        ],
      },
      {
        currentReplicas: 6,
        desiredReplicas: 8,
        currentMetrics: [
          { type: "External", external: { metricName: "nginx.net.request_per_s", currentValue: "60" } },
        ],
      },
    );
    expect(s.reference).toBe("Deployment/api");
    expect(s.targets[0]).toMatchObject({
      name: "nginx.net.request_per_s",
      source: "External",
      currentLabel: "60",
      targetLabel: "40 – 80",
      percent: 75,
      lowPercent: 50,
    });
    expect(formatReplicas(s)).toBe("6 → 8");
  });

  test("accepts a Resource metric and the currentAverageValue spelling", () => {
    const s = wpa(
      { metrics: [{ type: "Resource", resource: { name: "cpu", highWatermark: "800m", lowWatermark: "400m" } }] },
      { currentMetrics: [{ type: "Resource", resource: { name: "cpu", currentAverageValue: "600m" } }] },
    );
    expect(s.targets[0]).toMatchObject({
      name: "cpu",
      currentLabel: "600m",
      targetLabel: "400m – 800m",
      percent: 75,
    });
  });

  test("reads a Resource metric reported as a utilization percentage", () => {
    // The watermarks are quantities but the status side may answer in percent.
    const s = wpa(
      { metrics: [{ type: "Resource", resource: { name: "cpu", highWatermark: "80", lowWatermark: "40" } }] },
      { currentMetrics: [{ type: "Resource", resource: { name: "cpu", currentAverageUtilization: 60 } }] },
    );
    expect(s.targets[0]).toMatchObject({
      name: "cpu",
      currentLabel: "60%",
      targetLabel: "40 – 80",
      percent: 75,
    });
  });

  test("marks a dry-run autoscaler from the spec or from the condition", () => {
    expect(wpa({ dryRun: true }).dryRun).toBe(true);
    // The controller can force dry-run on, and only says so in the condition.
    expect(wpa({}, { conditions: [{ type: "DryRun", status: "True" }] }).dryRun).toBe(true);
    expect(wpa({}, { conditions: [{ type: "DryRun", status: "False" }] }).dryRun).toBe(false);
    expect(wpa({}).dryRun).toBe(false);
  });

  test("reads nothing without falling over when the metric has no reading", () => {
    const s = wpa({ metrics: [{ type: "External", external: { metricName: "q", highWatermark: "10" } }] });
    expect(s.targets[0]).toMatchObject({ currentLabel: UNKNOWN, targetLabel: "10", percent: null });
  });
});

describe("vpa", () => {
  const vpa = (spec: Record<string, unknown>, status: Record<string, unknown> = {}) =>
    autoscalerSummary(res("VerticalPodAutoscaler", spec, status), "vpa");

  test("has no replica bounds and reads targetRef", () => {
    const s = vpa({ targetRef: { kind: "Deployment", name: "api" }, minReplicas: 2 });
    expect(s.reference).toBe("Deployment/api");
    expect(s.min).toBeNull();
    expect(s.current).toBeNull();
    expect(formatReplicas(s)).toBe("-");
  });

  test("turns each container recommendation into a target row", () => {
    const s = vpa(
      { updatePolicy: { updateMode: "Auto" } },
      {
        recommendation: {
          containerRecommendations: [
            {
              containerName: "app",
              target: { cpu: "250m", memory: "512Mi" },
              lowerBound: { cpu: "100m", memory: "256Mi" },
              upperBound: { cpu: "1", memory: "1Gi" },
            },
          ],
        },
      },
    );
    expect(s.updateMode).toBe("Auto");
    expect(s.targets).toHaveLength(2);
    expect(s.targets[0]).toMatchObject({
      name: "app/cpu",
      source: "Recommendation",
      currentLabel: "250m",
      targetLabel: "100m – 1",
      percent: null,
    });
    expect(s.targets[1]!.name).toBe("app/memory");
    expect(formatTargets(s)).toBe("app/cpu: 250m/100m – 1, app/memory: 512Mi/256Mi – 1Gi");
  });

  test("marks a one-sided recommendation as a bound instead of a bare number", () => {
    const s = vpa({}, {
      recommendation: {
        containerRecommendations: [
          { containerName: "app", target: { cpu: "250m" }, lowerBound: { cpu: "100m" } },
          { containerName: "sidecar", target: { cpu: "50m" }, upperBound: { cpu: "1" } },
          { containerName: "bare", target: { cpu: "10m" } },
        ],
      },
    });
    expect(s.targets.map((t) => t.targetLabel)).toEqual(["≥ 100m", "≤ 1", UNKNOWN]);
    // No dangling separator: the cell used to read "250m/".
    expect(formatTargets(s)).toBe("app/cpu: 250m/≥ 100m, sidecar/cpu: 50m/≤ 1 +1");
  });

  test("skips a resource the recommender has no target for", () => {
    const s = vpa({}, {
      recommendation: { containerRecommendations: [{ containerName: "app", target: { cpu: "250m" } }] },
    });
    expect(s.targets.map((t) => t.name)).toEqual(["app/cpu"]);
  });
});

describe("formatTargets", () => {
  test("collapses the tail past the cap", () => {
    const s = autoscalerSummary(
      res("HorizontalPodAutoscaler", {
        metrics: [
          { type: "Resource", resource: { name: "cpu", target: { averageUtilization: 80 } } },
          { type: "Resource", resource: { name: "memory", target: { averageUtilization: 70 } } },
          { type: "Pods", pods: { metric: { name: "rps" }, target: { averageValue: "10" } } },
        ],
      }),
      "hpa",
    );
    expect(formatTargets(s)).toBe("cpu: <unknown>/80%, memory: <unknown>/70% +1");
  });
});
