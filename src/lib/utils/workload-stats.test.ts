import { describe, expect, test } from "bun:test";
import {
  computeWorkloadStats,
  computePodStats,
  computeDeploymentStats,
  computeServiceStats,
  computeStatefulSetStats,
  computeDaemonSetStats,
  computeJobStats,
  computeCronJobStats,
  computeNodeStats,
  computeIngressStats,
  computeReplicaSetStats,
  computeConfigMapStats,
  computeSecretStats,
  computeNamespaceStats,
  computePVCStats,
  classifyPodStatus,
  classifyDeployment,
  classifyDaemonSet,
  matchesStatFilter,
} from "./workload-stats";
import type { Resource } from "$lib/types";

function makeResource(overrides: Partial<Resource> = {}): Resource {
  return {
    kind: "Pod",
    api_version: "v1",
    metadata: {
      name: "test",
      uid: "uid-1",
      creation_timestamp: "2025-01-01T00:00:00Z",
      labels: {},
      annotations: {},
      owner_references: [],
      resource_version: "1",
    },
    spec: {},
    status: {},
    ...overrides,
  };
}

// --- classifyPodStatus ---

describe("classifyPodStatus", () => {
  test("Running pod", () => {
    const r = makeResource({ status: { phase: "Running" } });
    expect(classifyPodStatus(r)).toBe("running");
  });

  test("Pending pod", () => {
    const r = makeResource({ status: { phase: "Pending" } });
    expect(classifyPodStatus(r)).toBe("pending");
  });

  test("Failed pod", () => {
    const r = makeResource({ status: { phase: "Failed" } });
    expect(classifyPodStatus(r)).toBe("failed");
  });

  test("Succeeded pod", () => {
    const r = makeResource({ status: { phase: "Succeeded" } });
    expect(classifyPodStatus(r)).toBe("succeeded");
  });

  test("Running pod with CrashLoopBackOff container", () => {
    const r = makeResource({
      status: {
        phase: "Running",
        containerStatuses: [
          { state: { waiting: { reason: "CrashLoopBackOff" } } },
        ],
      },
    });
    expect(classifyPodStatus(r)).toBe("failed");
  });

  test("Running pod with terminated error container", () => {
    const r = makeResource({
      status: {
        phase: "Running",
        containerStatuses: [
          { state: { terminated: { exitCode: 1 } } },
        ],
      },
    });
    expect(classifyPodStatus(r)).toBe("failed");
  });

  test("Running pod with healthy containers", () => {
    const r = makeResource({
      status: {
        phase: "Running",
        containerStatuses: [
          { state: { running: {} }, ready: true },
        ],
      },
    });
    expect(classifyPodStatus(r)).toBe("running");
  });

  test("Missing status returns unknown", () => {
    const r = makeResource({ status: {} });
    expect(classifyPodStatus(r)).toBe("unknown");
  });
});

// --- computePodStats ---

describe("computePodStats", () => {
  test("empty items", () => {
    const result = computePodStats([]);
    expect(result.stats[0].value).toBe(0); // total
    expect(result.stats[1].value).toBe(0); // running
  });

  test("mixed pod statuses", () => {
    const items = [
      makeResource({ status: { phase: "Running" } }),
      makeResource({ status: { phase: "Running" } }),
      makeResource({ status: { phase: "Pending" } }),
      makeResource({ status: { phase: "Failed" } }),
      makeResource({ status: { phase: "Succeeded" } }),
    ];
    const result = computePodStats(items);
    expect(result.stats[0].value).toBe(5);  // total
    expect(result.stats[1].value).toBe(2);  // running
    expect(result.stats[2].value).toBe(1);  // failing
    expect(result.stats[3].value).toBe(1);  // pending
  });

  test("restarts summed across containers", () => {
    const items = [
      makeResource({
        status: {
          phase: "Running",
          containerStatuses: [
            { restartCount: 5 },
            { restartCount: 3 },
          ],
        },
      }),
      makeResource({
        status: {
          phase: "Running",
          containerStatuses: [{ restartCount: 10 }],
        },
      }),
    ];
    const result = computePodStats(items);
    const restartsStat = result.stats.find((s) => s.key === "restarts");
    expect(restartsStat?.value).toBe(18);
  });

  test("null containerStatuses", () => {
    const items = [makeResource({ status: { phase: "Running" } })];
    const result = computePodStats(items);
    const restartsStat = result.stats.find((s) => s.key === "restarts");
    expect(restartsStat?.value).toBe(0);
  });

  test("health segments add up to total", () => {
    const items = [
      makeResource({ status: { phase: "Running" } }),
      makeResource({ status: { phase: "Pending" } }),
      makeResource({ status: { phase: "Failed" } }),
    ];
    const result = computePodStats(items);
    const segTotal = result.healthSegments.reduce((s, seg) => s + seg.value, 0);
    expect(segTotal).toBe(3);
  });
});

// --- computeDeploymentStats ---

describe("computeDeploymentStats", () => {
  test("empty items", () => {
    const result = computeDeploymentStats([]);
    expect(result.stats[0].value).toBe(0);
  });

  test("healthy deployment", () => {
    const items = [
      makeResource({
        spec: { replicas: 3 },
        status: { readyReplicas: 3, availableReplicas: 3, updatedReplicas: 3 },
      }),
    ];
    const result = computeDeploymentStats(items);
    expect(result.stats.find((s) => s.key === "healthy")?.value).toBe(1);
    expect(result.stats.find((s) => s.key === "degraded")?.value).toBe(0);
    expect(result.stats.find((s) => s.key === "failing")?.value).toBe(0);
  });

  test("degraded deployment", () => {
    const items = [
      makeResource({
        spec: { replicas: 3 },
        status: { readyReplicas: 1, availableReplicas: 1, updatedReplicas: 3 },
      }),
    ];
    const result = computeDeploymentStats(items);
    expect(result.stats.find((s) => s.key === "degraded")?.value).toBe(1);
  });

  test("failing deployment", () => {
    const items = [
      makeResource({
        spec: { replicas: 3 },
        status: { readyReplicas: 0, availableReplicas: 0, updatedReplicas: 0 },
      }),
    ];
    const result = computeDeploymentStats(items);
    expect(result.stats.find((s) => s.key === "failing")?.value).toBe(1);
  });

  test("rolling out deployment", () => {
    const items = [
      makeResource({
        spec: { replicas: 3 },
        status: { readyReplicas: 3, availableReplicas: 3, updatedReplicas: 1 },
      }),
    ];
    const result = computeDeploymentStats(items);
    expect(result.stats.find((s) => s.key === "rollingOut")?.value).toBe(1);
  });

  test("rolling out deployment is NOT counted as healthy (mutually exclusive)", () => {
    const items = [
      makeResource({
        spec: { replicas: 3 },
        status: { readyReplicas: 3, availableReplicas: 3, updatedReplicas: 1 },
      }),
    ];
    const result = computeDeploymentStats(items);
    expect(result.stats.find((s) => s.key === "rollingOut")?.value).toBe(1);
    expect(result.stats.find((s) => s.key === "healthy")?.value).toBe(0);
  });

  test("degraded + rolling out is classified as rolling out only", () => {
    const items = [
      makeResource({
        spec: { replicas: 3 },
        status: { readyReplicas: 1, availableReplicas: 1, updatedReplicas: 1 },
      }),
    ];
    const result = computeDeploymentStats(items);
    expect(result.stats.find((s) => s.key === "rollingOut")?.value).toBe(1);
    expect(result.stats.find((s) => s.key === "degraded")?.value).toBe(0);
  });

  test("stats sum to total", () => {
    const items = [
      makeResource({ spec: { replicas: 3 }, status: { availableReplicas: 3, updatedReplicas: 3 } }),
      makeResource({ spec: { replicas: 3 }, status: { availableReplicas: 3, updatedReplicas: 1 } }),
      makeResource({ spec: { replicas: 3 }, status: { availableReplicas: 1, updatedReplicas: 3 } }),
      makeResource({ spec: { replicas: 3 }, status: { availableReplicas: 0, updatedReplicas: 3 } }),
    ];
    const result = computeDeploymentStats(items);
    const total = result.stats.find((s) => s.key === "total")!.value;
    const healthy = result.stats.find((s) => s.key === "healthy")!.value;
    const degraded = result.stats.find((s) => s.key === "degraded")!.value;
    const failing = result.stats.find((s) => s.key === "failing")!.value;
    const rollingOut = result.stats.find((s) => s.key === "rollingOut")!.value;
    expect(healthy + degraded + failing + rollingOut).toBe(total);
  });

  test("scaled to zero is healthy", () => {
    const items = [
      makeResource({ spec: { replicas: 0 }, status: {} }),
    ];
    const result = computeDeploymentStats(items);
    expect(result.stats.find((s) => s.key === "healthy")?.value).toBe(1);
  });
});

// --- computeServiceStats ---

describe("computeServiceStats", () => {
  test("mixed service types", () => {
    const items = [
      makeResource({ spec: { type: "ClusterIP" } }),
      makeResource({ spec: { type: "ClusterIP" } }),
      makeResource({ spec: { type: "NodePort" } }),
      makeResource({ spec: { type: "LoadBalancer" }, status: { loadBalancer: { ingress: [{ ip: "1.2.3.4" }] } } }),
      makeResource({ spec: { type: "ExternalName" } }),
    ];
    const result = computeServiceStats(items);
    expect(result.stats.find((s) => s.key === "clusterIP")?.value).toBe(2);
    expect(result.stats.find((s) => s.key === "nodePort")?.value).toBe(1);
    expect(result.stats.find((s) => s.key === "loadBalancer")?.value).toBe(1);
    expect(result.stats.find((s) => s.key === "externalName")?.value).toBe(1);
  });

  test("default type is ClusterIP", () => {
    const items = [makeResource({ spec: {} })];
    const result = computeServiceStats(items);
    expect(result.stats.find((s) => s.key === "clusterIP")?.value).toBe(1);
  });
});

// --- computeStatefulSetStats ---

describe("computeStatefulSetStats", () => {
  test("healthy and degraded", () => {
    const items = [
      makeResource({ spec: { replicas: 3 }, status: { readyReplicas: 3 } }),
      makeResource({ spec: { replicas: 3 }, status: { readyReplicas: 1 } }),
    ];
    const result = computeStatefulSetStats(items);
    expect(result.stats.find((s) => s.key === "healthy")?.value).toBe(1);
    expect(result.stats.find((s) => s.key === "degraded")?.value).toBe(1);
    expect(result.stats.find((s) => s.key === "replicas")?.value).toBe(6);
  });
});

// --- computeDaemonSetStats ---

describe("computeDaemonSetStats", () => {
  test("healthy, unavailable, misscheduled", () => {
    const items = [
      makeResource({ status: { desiredNumberScheduled: 3, numberReady: 3, numberAvailable: 3, numberMisscheduled: 0 } }),
      makeResource({ status: { desiredNumberScheduled: 3, numberReady: 1, numberAvailable: 1, numberMisscheduled: 0 } }),
      makeResource({ status: { desiredNumberScheduled: 3, numberReady: 3, numberAvailable: 3, numberMisscheduled: 2 } }),
    ];
    const result = computeDaemonSetStats(items);
    expect(result.stats.find((s) => s.key === "healthy")?.value).toBe(1);
    expect(result.stats.find((s) => s.key === "unavailable")?.value).toBe(1);
    expect(result.stats.find((s) => s.key === "misscheduled")?.value).toBe(1);
  });

  test("misscheduled DaemonSet is NOT counted as healthy (mutually exclusive)", () => {
    const items = [
      makeResource({ status: { desiredNumberScheduled: 3, numberReady: 3, numberAvailable: 3, numberMisscheduled: 1 } }),
    ];
    const result = computeDaemonSetStats(items);
    expect(result.stats.find((s) => s.key === "misscheduled")?.value).toBe(1);
    expect(result.stats.find((s) => s.key === "healthy")?.value).toBe(0);
  });

  test("stats sum to total", () => {
    const items = [
      makeResource({ status: { desiredNumberScheduled: 3, numberReady: 3, numberAvailable: 3, numberMisscheduled: 0 } }),
      makeResource({ status: { desiredNumberScheduled: 3, numberReady: 1, numberAvailable: 1, numberMisscheduled: 0 } }),
      makeResource({ status: { desiredNumberScheduled: 3, numberReady: 3, numberAvailable: 3, numberMisscheduled: 2 } }),
    ];
    const result = computeDaemonSetStats(items);
    const total = result.stats.find((s) => s.key === "total")!.value;
    const healthy = result.stats.find((s) => s.key === "healthy")!.value;
    const unavailable = result.stats.find((s) => s.key === "unavailable")!.value;
    const misscheduled = result.stats.find((s) => s.key === "misscheduled")!.value;
    expect(healthy + unavailable + misscheduled).toBe(total);
  });
});

// --- computeJobStats ---

describe("computeJobStats", () => {
  test("mixed job statuses", () => {
    const items = [
      makeResource({ status: { succeeded: 1, failed: 0, active: 0 } }),
      makeResource({ status: { succeeded: 0, failed: 2, active: 0 } }),
      makeResource({ status: { succeeded: 0, failed: 0, active: 1 } }),
    ];
    const result = computeJobStats(items);
    expect(result.stats.find((s) => s.key === "succeeded")?.value).toBe(1);
    expect(result.stats.find((s) => s.key === "failed")?.value).toBe(1);
    expect(result.stats.find((s) => s.key === "active")?.value).toBe(1);
  });
});

// --- computeCronJobStats ---

describe("computeCronJobStats", () => {
  test("active and suspended", () => {
    const items = [
      makeResource({ spec: { suspend: false }, status: { active: [{}] } }),
      makeResource({ spec: { suspend: true }, status: {} }),
      makeResource({ spec: { suspend: false }, status: {} }),
    ];
    const result = computeCronJobStats(items);
    expect(result.stats.find((s) => s.key === "active")?.value).toBe(1);
    expect(result.stats.find((s) => s.key === "suspended")?.value).toBe(1);
  });
});

// --- computeNodeStats ---

describe("computeNodeStats", () => {
  test("ready and not ready", () => {
    const items = [
      makeResource({ status: { conditions: [{ type: "Ready", status: "True" }] } }),
      makeResource({ status: { conditions: [{ type: "Ready", status: "False" }] } }),
      makeResource({ status: { conditions: [] } }),
    ];
    const result = computeNodeStats(items);
    expect(result.stats.find((s) => s.key === "ready")?.value).toBe(1);
    expect(result.stats.find((s) => s.key === "notReady")?.value).toBe(2);
  });
});

// --- computeIngressStats ---

describe("computeIngressStats", () => {
  test("TLS and hosts", () => {
    const items = [
      makeResource({ spec: { tls: [{}], rules: [{ host: "a.com" }, { host: "b.com" }] } }),
      makeResource({ spec: { rules: [{ host: "a.com" }] } }),
    ];
    const result = computeIngressStats(items);
    expect(result.stats.find((s) => s.key === "withTLS")?.value).toBe(1);
    expect(result.stats.find((s) => s.key === "withoutTLS")?.value).toBe(1);
    expect(result.stats.find((s) => s.key === "hosts")?.value).toBe(2);
  });
});

// --- computeReplicaSetStats ---

describe("computeReplicaSetStats", () => {
  test("active, orphaned, mismatched", () => {
    const items = [
      makeResource({
        spec: { replicas: 3 },
        status: { readyReplicas: 3 },
        metadata: { ...makeResource().metadata, owner_references: [{ api_version: "apps/v1", kind: "Deployment", name: "test", uid: "x", controller: true, block_owner_deletion: false }] },
      }),
      makeResource({
        spec: { replicas: 2 },
        status: { readyReplicas: 2 },
        metadata: { ...makeResource().metadata, owner_references: [] },
      }),
      makeResource({
        spec: { replicas: 3 },
        status: { readyReplicas: 1 },
        metadata: { ...makeResource().metadata, owner_references: [{ api_version: "apps/v1", kind: "Deployment", name: "test", uid: "x", controller: true, block_owner_deletion: false }] },
      }),
    ];
    const result = computeReplicaSetStats(items);
    expect(result.stats.find((s) => s.key === "active")?.value).toBe(1);
    expect(result.stats.find((s) => s.key === "orphaned")?.value).toBe(1);
    expect(result.stats.find((s) => s.key === "mismatched")?.value).toBe(1);
  });
});

// --- computeSecretStats ---

describe("computeSecretStats", () => {
  test("type breakdown", () => {
    const items = [
      makeResource({ type: "Opaque" }),
      makeResource({ type: "kubernetes.io/tls" }),
      makeResource({ type: "kubernetes.io/dockerconfigjson" }),
      makeResource({ type: "kubernetes.io/service-account-token" }),
    ];
    const result = computeSecretStats(items);
    expect(result.stats.find((s) => s.key === "opaque")?.value).toBe(1);
    expect(result.stats.find((s) => s.key === "tls")?.value).toBe(1);
    expect(result.stats.find((s) => s.key === "dockerConfig")?.value).toBe(1);
    expect(result.stats.find((s) => s.key === "serviceAccount")?.value).toBe(1);
  });
});

// --- computeConfigMapStats ---

describe("computeConfigMapStats", () => {
  test("counts data keys", () => {
    const items = [
      makeResource({ data: { a: "1", b: "2" } }),
      makeResource({ data: { c: "3" } }),
    ];
    const result = computeConfigMapStats(items);
    expect(result.stats.find((s) => s.key === "keys")?.value).toBe(3);
  });
});

// --- computeNamespaceStats ---

describe("computeNamespaceStats", () => {
  test("active and terminating", () => {
    const items = [
      makeResource({ status: { phase: "Active" } }),
      makeResource({ status: { phase: "Terminating" } }),
    ];
    const result = computeNamespaceStats(items);
    expect(result.stats.find((s) => s.key === "active")?.value).toBe(1);
    expect(result.stats.find((s) => s.key === "terminating")?.value).toBe(1);
  });
});

// --- computePVCStats ---

describe("computePVCStats", () => {
  test("bound, pending, lost", () => {
    const items = [
      makeResource({ status: { phase: "Bound" } }),
      makeResource({ status: { phase: "Pending" } }),
      makeResource({ status: { phase: "Lost" } }),
    ];
    const result = computePVCStats(items);
    expect(result.stats.find((s) => s.key === "bound")?.value).toBe(1);
    expect(result.stats.find((s) => s.key === "pending")?.value).toBe(1);
    expect(result.stats.find((s) => s.key === "lost")?.value).toBe(1);
  });
});

// --- computeWorkloadStats dispatcher ---

describe("computeWorkloadStats", () => {
  test("dispatches to pod stats", () => {
    const result = computeWorkloadStats("pods", [makeResource({ status: { phase: "Running" } })]);
    expect(result.stats[0].value).toBe(1);
    expect(result.stats[1].key).toBe("running");
  });

  test("null items returns empty stats", () => {
    const result = computeWorkloadStats("pods", null as unknown as Resource[]);
    expect(result.stats[0].value).toBe(0);
  });

  test("unknown type returns default", () => {
    const result = computeWorkloadStats("unknown", [makeResource()]);
    expect(result.stats.length).toBe(1);
    expect(result.stats[0].key).toBe("total");
    expect(result.stats[0].value).toBe(1);
  });

  test("empty items returns zeroed stats for the given type", () => {
    const result = computeWorkloadStats("deployments", []);
    expect(result.stats[0].value).toBe(0);
    expect(result.stats.find((s) => s.key === "healthy")?.value).toBe(0);
  });
});

// --- matchesStatFilter ---

describe("matchesStatFilter", () => {
  test("pods: running filter", () => {
    const r = makeResource({ status: { phase: "Running" } });
    expect(matchesStatFilter(r, "pods", "running")).toBe(true);
    expect(matchesStatFilter(r, "pods", "failed")).toBe(false);
  });

  test("pods: failed filter with crashloop", () => {
    const r = makeResource({
      status: {
        phase: "Running",
        containerStatuses: [{ state: { waiting: { reason: "CrashLoopBackOff" } } }],
      },
    });
    expect(matchesStatFilter(r, "pods", "failed")).toBe(true);
    expect(matchesStatFilter(r, "pods", "running")).toBe(false);
  });

  test("deployments: healthy filter", () => {
    const r = makeResource({ spec: { replicas: 3 }, status: { availableReplicas: 3, updatedReplicas: 3 } });
    expect(matchesStatFilter(r, "deployments", "healthy")).toBe(true);
    expect(matchesStatFilter(r, "deployments", "failing")).toBe(false);
  });

  test("deployments: rollingOut excludes healthy in filter", () => {
    const r = makeResource({ spec: { replicas: 3 }, status: { availableReplicas: 3, updatedReplicas: 1 } });
    expect(matchesStatFilter(r, "deployments", "rollingOut")).toBe(true);
    expect(matchesStatFilter(r, "deployments", "healthy")).toBe(false);
  });

  test("daemonsets: misscheduled excludes healthy in filter", () => {
    const r = makeResource({ status: { desiredNumberScheduled: 3, numberAvailable: 3, numberMisscheduled: 1 } });
    expect(matchesStatFilter(r, "daemonsets", "misscheduled")).toBe(true);
    expect(matchesStatFilter(r, "daemonsets", "healthy")).toBe(false);
  });

  test("services: type filter", () => {
    const r = makeResource({ spec: { type: "NodePort" } });
    expect(matchesStatFilter(r, "services", "nodePort")).toBe(true);
    expect(matchesStatFilter(r, "services", "clusterIP")).toBe(false);
  });

  test("nodes: ready filter", () => {
    const r = makeResource({ status: { conditions: [{ type: "Ready", status: "True" }] } });
    expect(matchesStatFilter(r, "nodes", "ready")).toBe(true);
    expect(matchesStatFilter(r, "nodes", "notReady")).toBe(false);
  });

  test("secrets: type filter", () => {
    const r = makeResource({ type: "kubernetes.io/tls" });
    expect(matchesStatFilter(r, "secrets", "tls")).toBe(true);
    expect(matchesStatFilter(r, "secrets", "opaque")).toBe(false);
  });

  test("unknown type returns false", () => {
    const r = makeResource();
    expect(matchesStatFilter(r, "unknown", "anything")).toBe(false);
  });
});

// --- Sum invariant: filterable stats must sum to total for all resource types ---

describe("stat cards sum invariant", () => {
  const filterableSum = (stats: { key: string; value: number; filterable: boolean }[]) =>
    stats.filter((s) => s.filterable).reduce((sum, s) => sum + s.value, 0);
  const getTotal = (stats: { key: string; value: number }[]) =>
    stats.find((s) => s.key === "total")!.value;

  test("pods: filterable stats sum to total (excluding succeeded/restarts)", () => {
    const items = [
      makeResource({ status: { phase: "Running" } }),
      makeResource({ status: { phase: "Pending" } }),
      makeResource({ status: { phase: "Failed" } }),
      makeResource({ status: { phase: "Succeeded" } }),
    ];
    const result = computePodStats(items);
    // Succeeded pods are not shown in any filterable card, restarts is not filterable
    const running = result.stats.find((s) => s.key === "running")!.value;
    const failed = result.stats.find((s) => s.key === "failed")!.value;
    const pending = result.stats.find((s) => s.key === "pending")!.value;
    // running + failed + pending <= total (succeeded are excluded from filterable cards)
    expect(running + failed + pending).toBeLessThanOrEqual(getTotal(result.stats));
  });

  test("deployments: filterable stats sum to total", () => {
    const items = [
      makeResource({ spec: { replicas: 3 }, status: { availableReplicas: 3, updatedReplicas: 3 } }),
      makeResource({ spec: { replicas: 3 }, status: { availableReplicas: 3, updatedReplicas: 1 } }),
      makeResource({ spec: { replicas: 3 }, status: { availableReplicas: 1, updatedReplicas: 3 } }),
      makeResource({ spec: { replicas: 3 }, status: { availableReplicas: 0, updatedReplicas: 3 } }),
      makeResource({ spec: { replicas: 0 }, status: {} }),
    ];
    const result = computeDeploymentStats(items);
    expect(filterableSum(result.stats)).toBe(getTotal(result.stats));
  });

  test("services: filterable stats sum to total", () => {
    const items = [
      makeResource({ spec: { type: "ClusterIP" } }),
      makeResource({ spec: { type: "NodePort" } }),
      makeResource({ spec: { type: "LoadBalancer" } }),
      makeResource({ spec: { type: "ExternalName" } }),
    ];
    const result = computeServiceStats(items);
    expect(filterableSum(result.stats)).toBe(getTotal(result.stats));
  });

  test("statefulsets: filterable stats sum to total", () => {
    const items = [
      makeResource({ spec: { replicas: 3 }, status: { readyReplicas: 3 } }),
      makeResource({ spec: { replicas: 3 }, status: { readyReplicas: 1 } }),
    ];
    const result = computeStatefulSetStats(items);
    expect(filterableSum(result.stats)).toBe(getTotal(result.stats));
  });

  test("daemonsets: filterable stats sum to total", () => {
    const items = [
      makeResource({ status: { desiredNumberScheduled: 3, numberReady: 3, numberAvailable: 3, numberMisscheduled: 0 } }),
      makeResource({ status: { desiredNumberScheduled: 3, numberReady: 1, numberAvailable: 1, numberMisscheduled: 0 } }),
      makeResource({ status: { desiredNumberScheduled: 3, numberReady: 3, numberAvailable: 3, numberMisscheduled: 2 } }),
    ];
    const result = computeDaemonSetStats(items);
    expect(filterableSum(result.stats)).toBe(getTotal(result.stats));
  });

  test("nodes: filterable stats sum to total", () => {
    const items = [
      makeResource({ status: { conditions: [{ type: "Ready", status: "True" }] } }),
      makeResource({ status: { conditions: [{ type: "Ready", status: "False" }] } }),
    ];
    const result = computeNodeStats(items);
    expect(filterableSum(result.stats)).toBe(getTotal(result.stats));
  });

  test("namespaces: filterable stats sum to total", () => {
    const items = [
      makeResource({ status: { phase: "Active" } }),
      makeResource({ status: { phase: "Terminating" } }),
    ];
    const result = computeNamespaceStats(items);
    expect(filterableSum(result.stats)).toBe(getTotal(result.stats));
  });

  test("PVCs: filterable stats sum to total", () => {
    const items = [
      makeResource({ status: { phase: "Bound" } }),
      makeResource({ status: { phase: "Pending" } }),
      makeResource({ status: { phase: "Lost" } }),
    ];
    const result = computePVCStats(items);
    expect(filterableSum(result.stats)).toBe(getTotal(result.stats));
  });

  test("secrets: filterable stats sum to total", () => {
    const items = [
      makeResource({ type: "Opaque" }),
      makeResource({ type: "kubernetes.io/tls" }),
      makeResource({ type: "kubernetes.io/dockerconfigjson" }),
      makeResource({ type: "kubernetes.io/service-account-token" }),
    ];
    const result = computeSecretStats(items);
    expect(filterableSum(result.stats)).toBe(getTotal(result.stats));
  });

  test("ingresses: filterable stats sum to total", () => {
    const items = [
      makeResource({ spec: { tls: [{}], rules: [{ host: "a.com" }] } }),
      makeResource({ spec: { rules: [{ host: "b.com" }] } }),
    ];
    const result = computeIngressStats(items);
    expect(filterableSum(result.stats)).toBe(getTotal(result.stats));
  });
});
