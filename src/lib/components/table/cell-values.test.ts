import { test, expect, describe } from "bun:test";

import type { Resource } from "$lib/types";
import {
  autoscalerPressure,
  getCellValue as rawGetCellValue,
  isAutoscalerTargetsColumn,
  isMonoColumn,
  isTagColumn,
  isUsageColumn,
  usageMeter,
  type CellContext,
} from "./cell-values";
import { columnsByType } from "./table-columns";
import { autoscalerSummary } from "$lib/utils/autoscaler";

/** Store-derived context; the tests that care pass their own. */
const NO_CONTEXT: CellContext = { ageTick: 0 };

const getCellValue = (resource: Resource, key: string, ctx: CellContext = NO_CONTEXT): string =>
  rawGetCellValue(resource, key, ctx);

function res(partial: {
  name?: string;
  namespace?: string;
  labels?: Record<string, string>;
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
  data?: Record<string, unknown>;
}): Resource {
  return {
    kind: "Thing",
    api_version: "v1",
    metadata: {
      name: partial.name ?? "thing",
      namespace: partial.namespace,
      uid: "u1",
      creation_timestamp: "",
      labels: partial.labels ?? {},
      annotations: {},
      owner_references: [],
      resource_version: "1",
    },
    spec: partial.spec ?? {},
    status: partial.status ?? {},
    data: partial.data,
  } as Resource;
}

describe("getCellValue — shared columns", () => {
  test("unknown columns fall back to the placeholder", () => {
    expect(getCellValue(res({}), "no-such-column")).toBe("-");
  });

  test("a cluster-scoped resource has no namespace", () => {
    expect(getCellValue(res({}), "namespace")).toBe("-");
    expect(getCellValue(res({ namespace: "prod" }), "namespace")).toBe("prod");
  });

  test("status falls back from phase to status", () => {
    expect(getCellValue(res({ status: { phase: "Running" } }), "status")).toBe("Running");
    expect(getCellValue(res({ status: { status: "Bound" } }), "status")).toBe("Bound");
    expect(getCellValue(res({}), "phase")).toBe("-");
  });

  test("data counts keys wherever they live", () => {
    expect(getCellValue(res({ data: { a: "1", b: "2" } }), "data")).toBe("2");
    expect(getCellValue(res({}), "data")).toBe("0");
  });
});

describe("getCellValue — pods and workloads", () => {
  test("ready counts the ready containers", () => {
    const pod = res({ status: { containerStatuses: [{ ready: true }, { ready: false }] } });
    expect(getCellValue(pod, "ready")).toBe("1/2");
    expect(getCellValue(res({}), "ready")).toBe("-");
  });

  test("restarts sum across containers and default to zero", () => {
    const pod = res({ status: { containerStatuses: [{ restartCount: 2 }, { restartCount: 3 }] } });
    expect(getCellValue(pod, "restarts")).toBe("5");
    expect(getCellValue(res({}), "restarts")).toBe("0");
  });

  test("deployment readiness reads ready over desired", () => {
    const deploy = res({ spec: { replicas: 3 }, status: { readyReplicas: 2 } });
    expect(getCellValue(deploy, "deployReady")).toBe("2/3");
    expect(getCellValue(res({}), "deployReady")).toBe("0/0");
  });
});

describe("getCellValue — services and endpoints", () => {
  test("pods: effective status, ready fraction, owner", () => {
    const crashing = res({
      status: { phase: "Running", containerStatuses: [{ name: "a", ready: true, restartCount: 0, state: { running: {} } }, { name: "b", ready: false, restartCount: 3, state: { waiting: { reason: "CrashLoopBackOff" } } }] },
    });
    crashing.kind = "Pod";
    expect(getCellValue(crashing, "status")).toBe("CrashLoopBackOff");
    expect(getCellValue(crashing, "podReady")).toBe("1/2");
    const notPod = res({ status: { phase: "Running" } });
    expect(getCellValue(notPod, "status")).toBe("Running");
    const owned = res({});
    owned.metadata.owner_references = [{ api_version: "apps/v1", kind: "ReplicaSet", name: "api-7d9f", uid: "o", controller: true }];
    expect(getCellValue(owned, "controlledBy")).toBe("rs/api-7d9f");
    expect(getCellValue(res({}), "controlledBy")).toBe("-");
  });

  test("deployments: derived status, images, pod count", () => {
    const d = res({
      spec: { replicas: 3, template: { spec: { containers: [{ image: "ghcr.io/shop/api:2.4.1" }, { image: "otel/collector:0.98.0" }] } } },
      status: { replicas: 4, readyReplicas: 3, updatedReplicas: 1, conditions: [{ type: "Progressing", status: "True", reason: "ReplicaSetUpdated" }] },
    });
    expect(getCellValue(d, "deployStatus")).toBe("Progressing");
    expect(getCellValue(d, "images")).toBe("api:2.4.1, collector:0.98.0");
    expect(getCellValue(d, "pods")).toBe("4");
    expect(getCellValue(res({}), "images")).toBe("-");
  });

  test("services: external pending, ports with targets, endpoints from context", () => {
    expect(getCellValue(res({ spec: { type: "LoadBalancer" } }), "externalIP")).toBe("<pending>");
    expect(getCellValue(res({ spec: { ports: [{ port: 80, targetPort: 8080 }, { port: 443, targetPort: 443, nodePort: 30443 }] } }), "ports")).toBe("80→8080/TCP, 443/TCP :30443");
    expect(getCellValue(res({ spec: { selector: { app: "web" } } }), "selector")).toBe("app=web");
    const svc = res({});
    expect(getCellValue(svc, "endpoints")).toBe("");
    expect(getCellValue(svc, "endpoints", { ageTick: 0, endpoints: null })).toBe("-");
    expect(getCellValue(svc, "endpoints", { ageTick: 0, endpoints: { ready: 2, total: 3, terminating: 0 } })).toBe("2/3");
  });

  test("externalIP prefers the load balancer, then spec.externalIPs", () => {
    const lb = res({ status: { loadBalancer: { ingress: [{ ip: "1.2.3.4" }] } } });
    expect(getCellValue(lb, "externalIP")).toBe("1.2.3.4");
    expect(getCellValue(res({ spec: { externalIPs: ["5.6.7.8"] } }), "externalIP")).toBe("5.6.7.8");
    expect(getCellValue(res({}), "externalIP")).toBe("-");
  });

  test("endpoints show addresses with the subset port and collapse the tail", () => {
    const endpoints = res({
      spec: {
        subsets: [
          {
            ports: [{ port: 8080 }],
            addresses: [{ ip: "10.0.0.1" }, { ip: "10.0.0.2" }, { ip: "10.0.0.3" }, { ip: "10.0.0.4" }],
          },
        ],
      },
    });
    expect(getCellValue(endpoints, "endpointAddresses")).toBe(
      "10.0.0.1:8080, 10.0.0.2:8080, 10.0.0.3:8080 +1",
    );
  });

  test("an endpoint with no ready addresses reads <none>", () => {
    expect(getCellValue(res({ spec: { subsets: [] } }), "endpointAddresses")).toBe("<none>");
    expect(getCellValue(res({}), "sliceEndpoints")).toBe("<none>");
  });

  test("endpoint slice ports default the protocol", () => {
    const slice = res({ spec: { ports: [{ port: 80 }, { port: 443, protocol: "UDP" }] } });
    expect(getCellValue(slice, "slicePorts")).toBe("80/TCP, 443/UDP");
  });
});

describe("getCellValue — RBAC", () => {
  test("a binding shows Kind/name for its role and subjects", () => {
    const rb = res({
      spec: {
        roleRef: { kind: "Role", name: "reader" },
        subjects: [
          { kind: "ServiceAccount", name: "app" },
          { kind: "User", name: "nico" },
        ],
      },
    });
    expect(getCellValue(rb, "bindingRole")).toBe("Role/reader");
    expect(getCellValue(rb, "bindingSubjects")).toBe("ServiceAccount/app, User/nico");
  });

  test("a binding with no subjects is not blank", () => {
    expect(getCellValue(res({}), "bindingRole")).toBe("-");
    expect(getCellValue(res({}), "bindingSubjects")).toBe("-");
  });
});

describe("getCellValue — booleans and counts", () => {
  test("false is shown, absent is a placeholder", () => {
    expect(getCellValue(res({ spec: { attachRequired: false } }), "csiAttachRequired")).toBe("false");
    expect(getCellValue(res({ spec: { attachRequired: true } }), "csiAttachRequired")).toBe("true");
    expect(getCellValue(res({}), "csiAttachRequired")).toBe("-");
  });

  test("globalDefault is omitempty in the API, so absent means false", () => {
    expect(getCellValue(res({}), "pcGlobalDefault")).toBe("false");
    expect(getCellValue(res({ spec: { globalDefault: true } }), "pcGlobalDefault")).toBe("true");
  });

  test("webhook configurations count and name their hooks", () => {
    const cfg = res({ spec: { webhooks: [{ name: "a" }, { name: "b" }, { name: "c" }] } });
    expect(getCellValue(cfg, "webhookCount")).toBe("3");
    expect(getCellValue(cfg, "webhookNames")).toBe("a, b +1");
    expect(getCellValue(res({}), "webhookCount")).toBe("0");
  });

  test("service accounts count their secrets", () => {
    expect(getCellValue(res({ spec: { secrets: [{ name: "t" }] } }), "saSecrets")).toBe("1");
    expect(getCellValue(res({}), "saSecrets")).toBe("0");
  });
});

describe("getCellValue — nodes", () => {
  test("roles come from the node-role labels", () => {
    const node = res({
      labels: { "node-role.kubernetes.io/control-plane": "", "beta.kubernetes.io/arch": "arm64" },
    });
    expect(getCellValue(node, "roles")).toBe("control-plane");
    expect(getCellValue(res({}), "roles")).toBe("-");
  });

  test("kubelet version comes from status.nodeInfo", () => {
    expect(getCellValue(res({ status: { nodeInfo: { kubeletVersion: "v1.30.0" } } }), "version")).toBe(
      "v1.30.0",
    );
  });
});

describe("getCellValue — events", () => {
  const event = (spec: Record<string, unknown>) => res({ spec });

  test("eventType / eventReason / eventMessage read the synthetic spec", () => {
    const e = event({ type: "Warning", reason: "BackOff", message: "Back-off restarting container" });
    expect(getCellValue(e, "eventType")).toBe("Warning");
    expect(getCellValue(e, "eventReason")).toBe("BackOff");
    expect(getCellValue(e, "eventMessage")).toBe("Back-off restarting container");
  });

  test("eventObject renders Kind/name from involvedObject", () => {
    const e = event({ involvedObject: { kind: "Pod", name: "web-0" } });
    expect(getCellValue(e, "eventObject")).toBe("Pod/web-0");
    expect(getCellValue(event({}), "eventObject")).toBe("-");
  });

  test("eventCount prefers count, falls back to series.count, then 1", () => {
    expect(getCellValue(event({ count: 7 }), "eventCount")).toBe("7");
    expect(getCellValue(event({ series: { count: 3 } }), "eventCount")).toBe("3");
    expect(getCellValue(event({}), "eventCount")).toBe("1");
  });

  test("eventLastSeen prefers lastTimestamp over the other observation fields", () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const old = new Date(Date.now() - 3_600_000).toISOString();
    expect(getCellValue(event({ lastTimestamp: recent, firstTimestamp: old }), "eventLastSeen")).toBe("1m");
    expect(getCellValue(event({ series: { lastObservedTime: recent } }), "eventLastSeen")).toBe("1m");
    expect(getCellValue(event({ eventTime: recent }), "eventLastSeen")).toBe("1m");
  });
});

describe("column families", () => {
  test("every usage column is routed to the meter renderer", () => {
    for (const key of ["cpuUsage", "memUsage", "podCpu", "podMemory"]) {
      expect(isUsageColumn(key)).toBe(true);
    }
    expect(isUsageColumn("name")).toBe(false);
  });

  test("no declared column belongs to two render families", () => {
    // Each family is a branch in TableRow's cell markup, and the branches are
    // tried in order — a key in two families renders as whichever branch comes
    // first, which is a silent, type-checked-clean way to lose a column.
    const families = [isMonoColumn, isTagColumn, isUsageColumn, isAutoscalerTargetsColumn];
    const overlapping = [...new Set(Object.values(columnsByType).flat().map((c) => c.key))].filter(
      (key) => families.filter((inFamily) => inFamily(key)).length > 1,
    );
    expect(overlapping).toEqual([]);
  });

  test("the autoscaler targets column is routed to its own renderer", () => {
    expect(isAutoscalerTargetsColumn("autoscalerTargets")).toBe(true);
    expect(isAutoscalerTargetsColumn("autoscalerReplicas")).toBe(false);
  });
});

describe("autoscaler cells", () => {
  const hpa = res({
    spec: {
      scaleTargetRef: { kind: "Deployment", name: "api" },
      minReplicas: 2,
      maxReplicas: 10,
      metrics: [
        { type: "Resource", resource: { name: "cpu", target: { averageUtilization: 80 } } },
      ],
    },
    status: {
      currentReplicas: 3,
      desiredReplicas: 5,
      currentMetrics: [
        { type: "Resource", resource: { name: "cpu", current: { averageUtilization: 60 } } },
      ],
    },
  });
  const ctx: CellContext = { ageTick: 0, autoscaler: autoscalerSummary(hpa, "hpa") };

  test("reads every column off the row's summary", () => {
    expect(getCellValue(hpa, "autoscalerReference", ctx)).toBe("Deployment/api");
    expect(getCellValue(hpa, "autoscalerMin", ctx)).toBe("2");
    expect(getCellValue(hpa, "autoscalerMax", ctx)).toBe("10");
    expect(getCellValue(hpa, "autoscalerReplicas", ctx)).toBe("3 → 5");
    expect(getCellValue(hpa, "autoscalerTargets", ctx)).toBe("cpu: 60%/80%");
  });

  test("renders as empty on a row that is not an autoscaler", () => {
    // The summary is only built for the three autoscaler tables; without it
    // the columns must degrade to "-" rather than throw.
    for (const key of ["autoscalerReference", "autoscalerMin", "autoscalerReplicas", "autoscalerTargets"]) {
      expect(getCellValue(res({}), key)).toBe("-");
    }
  });

  test("the pressure bar tracks the metric that is furthest along", () => {
    const twoMetrics = res({
      spec: {
        metrics: [
          { type: "Resource", resource: { name: "cpu", target: { averageUtilization: 80 } } },
          { type: "Resource", resource: { name: "memory", target: { averageUtilization: 50 } } },
        ],
      },
      status: {
        currentMetrics: [
          { type: "Resource", resource: { name: "cpu", current: { averageUtilization: 20 } } },
          { type: "Resource", resource: { name: "memory", current: { averageUtilization: 45 } } },
        ],
      },
    });
    const pressure = autoscalerPressure(autoscalerSummary(twoMetrics, "hpa"))!;
    // memory is at 90% of its target, cpu at 25% — the bar follows memory.
    expect(pressure.percent).toBe(90);
    expect(pressure.title).toContain("memory: 45% of 50%");
    // Every metric is split, so the row can pin each reading and let only the
    // names give up width.
    expect(pressure.parts).toEqual([
      { name: "cpu", value: "20%/80%" },
      { name: "memory", value: "45%/50%" },
    ]);
  });

  test("splits a metric so the reading can be protected from truncation", () => {
    // An external metric name is long enough to push the numbers out of the
    // cell; the split lets the row truncate the name and keep the value.
    const wpa = res({
      spec: {
        metrics: [{
          type: "External",
          external: { metricName: "nginx.net.request_per_s", highWatermark: "80", lowWatermark: "40" },
        }],
      },
      status: {
        currentMetrics: [{ type: "External", external: { metricName: "nginx.net.request_per_s", currentValue: "62" } }],
      },
    });
    const pressure = autoscalerPressure(autoscalerSummary(wpa, "wpa"))!;
    expect(pressure.parts).toEqual([{ name: "nginx.net.request_per_s", value: "62/40 – 80" }]);
    expect(pressure.meter).toBe(true);
  });

  test("a VPA row draws no track, having no ceiling to fill towards", () => {
    const vpa = res({
      status: {
        recommendation: {
          containerRecommendations: [
            { containerName: "app", target: { cpu: "250m" }, lowerBound: { cpu: "100m" }, upperBound: { cpu: "1" } },
          ],
        },
      },
    });
    const pressure = autoscalerPressure(autoscalerSummary(vpa, "vpa"))!;
    expect(pressure.meter).toBe(false);
    expect(pressure.percent).toBeNull();
  });

  test("names a dry run in the tooltip, since the row's numbers are advisory", () => {
    const dry = res({
      spec: {
        dryRun: true,
        metrics: [{ type: "Resource", resource: { name: "cpu", highWatermark: "80", lowWatermark: "30" } }],
      },
    });
    expect(autoscalerPressure(autoscalerSummary(dry, "wpa"))!.title).toContain("dry run");
  });

  test("names the limit in the tooltip when the autoscaler is capped", () => {
    const capped = res({
      spec: { metrics: [{ type: "Resource", resource: { name: "cpu", target: { averageUtilization: 80 } } }] },
      status: { conditions: [{ type: "ScalingLimited", status: "True", reason: "TooManyReplicas" }] },
    });
    expect(autoscalerPressure(autoscalerSummary(capped, "hpa"))!.title).toContain("limited: TooManyReplicas");
  });

  test("has nothing to paint for an autoscaler with no metrics", () => {
    expect(autoscalerPressure(undefined)).toBeNull();
    expect(autoscalerPressure(autoscalerSummary(res({}), "hpa"))).toBeNull();
  });
});

describe("usage meters", () => {
  test("a node meter reads capacity from the metrics cache", () => {
    const meter = usageMeter(res({ name: "node-1" }), "cpuUsage", {
      ageTick: 0,
      nodeMetrics: {
        node_name: "node-1",
        cpu_usage: 0.5,
        cpu_capacity: 4,
        cpu_percent: 12.5,
        memory_usage: 2 * 1024 ** 3,
        memory_capacity: 8 * 1024 ** 3,
        memory_percent: 25,
      },
    })!;
    expect(meter.label).toBe("500m");
    expect(meter.basisLabel).toBe("4");
    expect(meter.percent).toBe(13);
    expect(meter.title).toContain("capacity");
  });

  test("a node with no metrics has no meter at all", () => {
    expect(usageMeter(res({ name: "node-1" }), "memUsage", NO_CONTEXT)).toBeNull();
  });

  test("a pod meter fills towards the limit and says so", () => {
    const pod = res({
      namespace: "prod",
      spec: {
        containers: [{ name: "app", resources: { requests: { cpu: "100m" }, limits: { cpu: "500m" } } }],
      },
    });
    const meter = usageMeter(pod, "podCpu", {
      ageTick: 0,
      podUsage: { name: "thing", namespace: "prod", cpu_cores: 0.25, memory_bytes: 0, containers: [] },
    })!;
    expect(meter.label).toBe("250m");
    expect(meter.basisLabel).toBe("500m");
    expect(meter.percent).toBe(50);
    expect(meter.title).toContain("limit 500m");
    expect(meter.title).toContain("50% of the limit");
  });

  test("a pod with no usage yet has no meter", () => {
    expect(usageMeter(res({}), "podMemory", NO_CONTEXT)).toBeNull();
  });
});

describe("getCellValue — controllers, jobs, ingresses, secrets, nodes", () => {
  const kind = (k: string, partial: Parameters<typeof res>[0]) => ({ ...res(partial), kind: k });

  test("replicasets show desired/current/ready counters", () => {
    const rs = kind("ReplicaSet", { spec: { replicas: 3 }, status: { replicas: 3, readyReplicas: 2 } });
    expect(getCellValue(rs, "rsDesired")).toBe("3");
    expect(getCellValue(rs, "rsCurrent")).toBe("3");
    expect(getCellValue(rs, "rsReady")).toBe("2");
    // Controllers omit zero counters; the cell says 0, not "-".
    expect(getCellValue(kind("ReplicaSet", { spec: { replicas: 0 }, status: {} }), "rsReady")).toBe("0");
  });

  test("statefulsets and daemonsets", () => {
    expect(getCellValue(kind("StatefulSet", { spec: { replicas: 2 }, status: { readyReplicas: 2 } }), "stsReady")).toBe("2/2");
    const ds = kind("DaemonSet", { status: { desiredNumberScheduled: 3, currentNumberScheduled: 3, numberReady: 2, numberAvailable: 2 } });
    expect(getCellValue(ds, "dsDesired")).toBe("3");
    expect(getCellValue(ds, "dsReady")).toBe("2");
    expect(getCellValue(ds, "dsAvailable")).toBe("2");
  });

  test("jobs: completions and duration", () => {
    const job = kind("Job", { spec: { completions: 1 }, status: { succeeded: 1, startTime: "2026-09-04T12:00:00Z", completionTime: "2026-09-04T12:00:42Z" } });
    expect(getCellValue(job, "jobCompletions")).toBe("1/1");
    expect(getCellValue(job, "jobDuration")).toBe("42s");
    expect(getCellValue(kind("Job", { status: {} }), "jobDuration")).toBe("-");
  });

  test("cronjobs: schedule, suspend, active, last schedule", () => {
    const cj = kind("CronJob", { spec: { schedule: "*/2 * * * *", suspend: true }, status: { active: [{ name: "x" }], lastScheduleTime: new Date(Date.now() - 90_000).toISOString() } });
    expect(getCellValue(cj, "cjSchedule")).toBe("*/2 * * * *");
    expect(getCellValue(cj, "cjSuspend")).toBe("true");
    expect(getCellValue(cj, "cjActive")).toBe("1");
    expect(getCellValue(cj, "cjLastSchedule")).not.toBe("-");
    expect(getCellValue(kind("CronJob", { spec: { schedule: "0 3 * * *" } }), "cjSuspend")).toBe("false");
    expect(getCellValue(kind("CronJob", { spec: { schedule: "0 3 * * *" } }), "cjLastSchedule")).toBe("-");
  });

  test("ingresses: class, hosts and address", () => {
    const ing = kind("Ingress", {
      spec: { ingressClassName: "nginx", rules: [{ host: "shop.example.com" }, { host: "api.example.com" }] },
      status: { loadBalancer: { ingress: [{ ip: "10.0.0.9" }] } },
    });
    expect(getCellValue(ing, "ingressClass")).toBe("nginx");
    expect(getCellValue(ing, "ingressHosts")).toBe("shop.example.com, api.example.com");
    expect(getCellValue(ing, "ingressAddress")).toBe("10.0.0.9");
    expect(getCellValue(kind("Ingress", { spec: { rules: [{}] } }), "ingressHosts")).toBe("*");
    expect(getCellValue(kind("Ingress", { spec: {} }), "ingressAddress")).toBe("-");
  });

  test("secret type lives at the top level, service type under spec", () => {
    const secret = { ...res({ data: { a: "b" } }), kind: "Secret", type: "kubernetes.io/tls" };
    expect(getCellValue(secret, "type")).toBe("kubernetes.io/tls");
    expect(getCellValue(kind("Service", { spec: { type: "NodePort" } }), "type")).toBe("NodePort");
  });

  test("node status is its Ready condition", () => {
    const ready = kind("Node", { status: { conditions: [{ type: "Ready", status: "True" }] } });
    const notReady = kind("Node", { status: { conditions: [{ type: "Ready", status: "False", reason: "KubeletNotReady" }] } });
    expect(getCellValue(ready, "status")).toBe("Ready");
    expect(getCellValue(notReady, "status")).toBe("NotReady");
  });
});
