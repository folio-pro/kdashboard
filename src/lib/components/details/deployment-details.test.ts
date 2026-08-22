import { describe, expect, test } from "bun:test";
import type { Resource } from "$lib/types";
import {
  deploymentRevision,
  findAutoscalerFor,
  requestTotals,
  servicesSelecting,
  strategyLabel,
  templateContainerRows,
  templateReferences,
} from "./deployment-details.logic";

function res(kind: string, name: string, spec: Record<string, unknown>, annotations: Record<string, string> = {}): Resource {
  return {
    kind,
    api_version: "v1",
    metadata: { name, namespace: "ns", uid: name, creation_timestamp: "", labels: {}, annotations, resource_version: "1", owner_references: [] },
    spec,
    status: {},
  };
}

const deploy = res("Deployment", "api", {
  replicas: 3,
  strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: "50%", maxUnavailable: 1 } },
  template: {
    metadata: { labels: { app: "api", tier: "backend" } },
    spec: {
      serviceAccountName: "api",
      volumes: [
        { name: "cfg", configMap: { name: "api-config" } },
        { name: "creds", secret: { secretName: "api-db" } },
        { name: "cache", persistentVolumeClaim: { claimName: "api-cache" } },
        { name: "proj", projected: { sources: [{ configMap: { name: "ca" } }, { secret: { name: "api-db" } }] } },
      ],
      initContainers: [{ name: "migrate", image: "api:2.4.1", envFrom: [{ secretRef: { name: "migrate-secret" } }] }],
      containers: [
        {
          name: "api",
          image: "ghcr.io/shop/api:2.4.1",
          ports: [{ containerPort: 8080 }, { containerPort: 9090, protocol: "UDP" }],
          env: [{ name: "A", value: "1" }, { name: "B", valueFrom: { configMapKeyRef: { name: "api-config", key: "b" } } }],
          envFrom: [{ configMapRef: { name: "api-env" } }],
          resources: { requests: { cpu: "250m", memory: "128Mi" }, limits: { cpu: "500m", memory: "256Mi" } },
          livenessProbe: {},
          readinessProbe: {},
        },
        { name: "otel", image: "otel/collector:0.98.0", resources: { requests: { cpu: "100m", memory: "64Mi" } } },
      ],
    },
  },
}, { "deployment.kubernetes.io/revision": "12" });

describe("templateContainerRows", () => {
  test("one row per container with request/limit, ports, probes and env count", () => {
    const rows = templateContainerRows(deploy);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      name: "api", image: "ghcr.io/shop/api:2.4.1", cpu: "250m / 500m", memory: "128Mi / 256Mi",
      ports: "8080/TCP, 9090/UDP", probes: { liveness: true, readiness: true, startup: false }, envCount: 3,
    });
    expect(rows[1]).toMatchObject({ cpu: "100m / —", ports: "—", probes: { liveness: false, readiness: false, startup: false }, envCount: 0 });
  });
});

describe("requestTotals", () => {
  test("sums requests per pod and multiplies by replicas", () => {
    const t = requestTotals(deploy);
    expect(t.cpuPerPod).toBeCloseTo(0.35);
    expect(t.memoryPerPod).toBe(192 * 1024 * 1024);
    expect(t.replicas).toBe(3);
    expect(t.perPodLabel).toBe("350m · 192 Mi");
    expect(t.totalLabel).toBe("1.05 · 576 Mi");
  });

  test("no requests and no replicas field", () => {
    const t = requestTotals(res("Deployment", "x", { template: { spec: { containers: [{ name: "a" }] } } }));
    expect(t.replicas).toBe(1);
    expect(t.perPodLabel).toBe("0m · 0");
  });
});

describe("revision / strategy", () => {
  test("revision from the annotation, strategy summarised", () => {
    expect(deploymentRevision(deploy)).toBe(12);
    expect(deploymentRevision(res("Deployment", "x", {}))).toBeNull();
    expect(strategyLabel(deploy)).toBe("RollingUpdate 50% / 1");
    expect(strategyLabel(res("Deployment", "x", {}))).toBe("RollingUpdate 25% / 25%");
    expect(strategyLabel(res("Deployment", "x", { strategy: { type: "Recreate" } }))).toBe("Recreate");
  });
});

describe("findAutoscalerFor / servicesSelecting / templateReferences", () => {
  test("matches the HPA by scaleTargetRef kind and name", () => {
    const mine = res("HorizontalPodAutoscaler", "api", { scaleTargetRef: { kind: "Deployment", name: "api" } });
    const other = res("HorizontalPodAutoscaler", "web", { scaleTargetRef: { kind: "Deployment", name: "web" } });
    const sts = res("HorizontalPodAutoscaler", "api-sts", { scaleTargetRef: { kind: "StatefulSet", name: "api" } });
    expect(findAutoscalerFor(deploy, [other, sts, mine])).toBe(mine);
    expect(findAutoscalerFor(deploy, [other])).toBeNull();
    // Same name in another namespace is somebody else's HPA.
    const elsewhere = { ...mine, metadata: { ...mine.metadata, namespace: "other" } };
    expect(findAutoscalerFor(deploy, [elsewhere])).toBeNull();
  });

  test("services whose selector is a subset of the template labels", () => {
    const api = res("Service", "api", { selector: { app: "api" } });
    const full = res("Service", "api-backend", { selector: { app: "api", tier: "backend" } });
    const web = res("Service", "web", { selector: { app: "web" } });
    const empty = res("Service", "none", { selector: {} });
    const ext = res("Service", "ext", { type: "ExternalName" });
    expect(servicesSelecting(deploy, [api, full, web, empty, ext]).map((s) => s.metadata.name)).toEqual(["api", "api-backend"]);
    const foreign = { ...api, metadata: { ...api.metadata, namespace: "other" } };
    expect(servicesSelecting(deploy, [foreign])).toEqual([]);
  });

  test("template references: volumes, projected, envFrom, env valueFrom, init containers, service account; deduped", () => {
    expect(templateReferences(deploy)).toEqual([
      { kind: "ConfigMap", name: "api-config" },
      { kind: "Secret", name: "api-db" },
      { kind: "PersistentVolumeClaim", name: "api-cache" },
      { kind: "ConfigMap", name: "ca" },
      { kind: "Secret", name: "migrate-secret" },
      { kind: "ConfigMap", name: "api-env" },
      { kind: "ServiceAccount", name: "api" },
    ]);
  });
});
