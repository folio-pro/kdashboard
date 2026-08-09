import { test, expect, describe } from "bun:test";

import type { Resource } from "$lib/types";
import {
  getCellValue as rawGetCellValue,
  isMonoColumn,
  isTagColumn,
  isUsageColumn,
  usageMeter,
  type CellContext,
} from "./cell-values";

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

describe("column families", () => {
  test("every usage column is routed to the meter renderer", () => {
    for (const key of ["cpuUsage", "memUsage", "podCpu", "podMemory"]) {
      expect(isUsageColumn(key)).toBe(true);
    }
    expect(isUsageColumn("name")).toBe(false);
  });

  test("mono and tag families do not overlap", () => {
    const both = ["age", "type", "roles", "vpaTarget", "pcGlobalDefault"].filter(
      (k) => isMonoColumn(k) && isTagColumn(k),
    );
    expect(both).toEqual([]);
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
