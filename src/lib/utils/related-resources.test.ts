import { describe, expect, test } from "bun:test";
import { kindToResourceType, displayKind, getRelatedResources } from "./related-resources";
import type { Resource } from "$lib/types";

function makeResource(overrides: Partial<Resource> = {}): Resource {
  return {
    kind: "Pod",
    api_version: "v1",
    metadata: {
      name: "test",
      uid: "uid-1",
      creation_timestamp: "2026-01-01T00:00:00Z",
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

describe("kindToResourceType", () => {
  test("maps known kinds correctly", () => {
    expect(kindToResourceType("Pod")).toBe("pods");
    expect(kindToResourceType("Deployment")).toBe("deployments");
    expect(kindToResourceType("HorizontalPodAutoscaler")).toBe("hpa");
    expect(kindToResourceType("Service")).toBe("services");
    expect(kindToResourceType("PersistentVolumeClaim")).toBe("persistentvolumeclaims");
  });

  test("falls back to lowercase+s for unknown kinds", () => {
    expect(kindToResourceType("Widget")).toBe("widgets");
    expect(kindToResourceType("FooBar")).toBe("foobars");
  });
});

describe("displayKind", () => {
  test("expands SA to ServiceAccount", () => {
    expect(displayKind("SA")).toBe("ServiceAccount");
  });

  test("expands Ext to ExternalName", () => {
    expect(displayKind("Ext")).toBe("ExternalName");
  });

  test("passes through other kinds unchanged", () => {
    expect(displayKind("Pod")).toBe("Pod");
    expect(displayKind("Deployment")).toBe("Deployment");
  });
});

describe("getRelatedResources", () => {
  test("extracts owner references", () => {
    const pod = makeResource({
      metadata: {
        ...makeResource().metadata,
        owner_references: [
          { api_version: "apps/v1", kind: "ReplicaSet", name: "my-rs", uid: "u1" },
        ],
      },
    });
    const related = getRelatedResources(pod, "pods");
    expect(related).toContainEqual({
      kind: "ReplicaSet",
      name: "my-rs",
      resourceType: "replicasets",
    });
  });

  test("skips owner references with unknown kind", () => {
    const pod = makeResource({
      metadata: {
        ...makeResource().metadata,
        owner_references: [
          { api_version: "v1", kind: "UnknownThing", name: "x", uid: "u1" },
        ],
      },
    });
    const related = getRelatedResources(pod, "pods");
    // rel() returns null for unknown kinds, so it should not appear
    expect(related.find((r) => r.name === "x")).toBeUndefined();
  });

  describe("pods", () => {
    test("links to Node via spec.nodeName", () => {
      const pod = makeResource({ spec: { nodeName: "node-1" } });
      const related = getRelatedResources(pod, "pods");
      expect(related).toContainEqual({
        kind: "Node",
        name: "node-1",
        resourceType: "nodes",
      });
    });

    test("links to Node via status.nodeName", () => {
      const pod = makeResource({ status: { nodeName: "node-2" } });
      const related = getRelatedResources(pod, "pods");
      expect(related).toContainEqual({
        kind: "Node",
        name: "node-2",
        resourceType: "nodes",
      });
    });

    test("links to ServiceAccount (non-default)", () => {
      const pod = makeResource({ spec: { serviceAccountName: "my-sa" } });
      const related = getRelatedResources(pod, "pods");
      expect(related).toContainEqual({
        kind: "SA",
        name: "my-sa",
        resourceType: "",
      });
    });

    test("does not link to default ServiceAccount", () => {
      const pod = makeResource({ spec: { serviceAccountName: "default" } });
      const related = getRelatedResources(pod, "pods");
      expect(related.find((r) => r.kind === "SA")).toBeUndefined();
    });

    test("links to ConfigMap, Secret, PVC from volumes", () => {
      const pod = makeResource({
        spec: {
          volumes: [
            { configMap: { name: "cm-1" } },
            { secret: { secretName: "sec-1" } },
            { persistentVolumeClaim: { claimName: "pvc-1" } },
          ],
        },
      });
      const related = getRelatedResources(pod, "pods");
      expect(related).toContainEqual({ kind: "ConfigMap", name: "cm-1", resourceType: "configmaps" });
      expect(related).toContainEqual({ kind: "Secret", name: "sec-1", resourceType: "secrets" });
      expect(related).toContainEqual({ kind: "PersistentVolumeClaim", name: "pvc-1", resourceType: "persistentvolumeclaims" });
    });

    test("links to ConfigMap and Secret from projected volumes", () => {
      const pod = makeResource({
        spec: {
          volumes: [
            {
              projected: {
                sources: [
                  { configMap: { name: "proj-cm" } },
                  { secret: { name: "proj-sec" } },
                ],
              },
            },
          ],
        },
      });
      const related = getRelatedResources(pod, "pods");
      expect(related).toContainEqual({ kind: "ConfigMap", name: "proj-cm", resourceType: "configmaps" });
      expect(related).toContainEqual({ kind: "Secret", name: "proj-sec", resourceType: "secrets" });
    });

    test("links to ConfigMap and Secret from envFrom", () => {
      const pod = makeResource({
        spec: {
          containers: [
            {
              envFrom: [
                { configMapRef: { name: "env-cm" } },
                { secretRef: { name: "env-sec" } },
              ],
            },
          ],
        },
      });
      const related = getRelatedResources(pod, "pods");
      expect(related).toContainEqual({ kind: "ConfigMap", name: "env-cm", resourceType: "configmaps" });
      expect(related).toContainEqual({ kind: "Secret", name: "env-sec", resourceType: "secrets" });
    });
  });

  describe("services", () => {
    test("links externalName", () => {
      const svc = makeResource({
        kind: "Service",
        spec: { externalName: "ext.example.com" },
      });
      const related = getRelatedResources(svc, "services");
      expect(related).toContainEqual({
        kind: "Ext",
        name: "ext.example.com",
        resourceType: "",
      });
    });
  });

  describe("statefulsets", () => {
    test("links to Service via serviceName", () => {
      const sts = makeResource({
        kind: "StatefulSet",
        spec: { serviceName: "headless-svc" },
      });
      const related = getRelatedResources(sts, "statefulsets");
      expect(related).toContainEqual({
        kind: "Service",
        name: "headless-svc",
        resourceType: "services",
      });
    });

    test("links volumeClaimTemplates", () => {
      const sts = makeResource({
        kind: "StatefulSet",
        spec: {
          volumeClaimTemplates: [{ metadata: { name: "data" } }],
        },
      });
      const related = getRelatedResources(sts, "statefulsets");
      expect(related).toContainEqual({
        kind: "PVC Template",
        name: "data",
        resourceType: "",
      });
    });
  });

  describe("hpa", () => {
    test("links to scaleTargetRef", () => {
      const hpa = makeResource({
        kind: "HorizontalPodAutoscaler",
        spec: { scaleTargetRef: { kind: "Deployment", name: "my-deploy" } },
      });
      const related = getRelatedResources(hpa, "hpa");
      expect(related).toContainEqual({
        kind: "Deployment",
        name: "my-deploy",
        resourceType: "deployments",
      });
    });
  });

  describe("vpa", () => {
    test("links to targetRef", () => {
      const vpa = makeResource({
        kind: "VerticalPodAutoscaler",
        spec: { targetRef: { kind: "Deployment", name: "my-deploy" } },
      });
      const related = getRelatedResources(vpa, "vpa");
      expect(related).toContainEqual({
        kind: "Deployment",
        name: "my-deploy",
        resourceType: "deployments",
      });
    });
  });

  describe("ingresses", () => {
    test("links to backend services from rules", () => {
      const ingress = makeResource({
        kind: "Ingress",
        spec: {
          rules: [
            {
              http: {
                paths: [
                  { backend: { service: { name: "web-svc" } } },
                  { backend: { service: { name: "api-svc" } } },
                ],
              },
            },
          ],
        },
      });
      const related = getRelatedResources(ingress, "ingresses");
      expect(related).toContainEqual({ kind: "Service", name: "web-svc", resourceType: "services" });
      expect(related).toContainEqual({ kind: "Service", name: "api-svc", resourceType: "services" });
    });

    test("links to defaultBackend service", () => {
      const ingress = makeResource({
        kind: "Ingress",
        spec: { defaultBackend: { service: { name: "default-svc" } } },
      });
      const related = getRelatedResources(ingress, "ingresses");
      expect(related).toContainEqual({ kind: "Service", name: "default-svc", resourceType: "services" });
    });

    test("links to TLS secrets", () => {
      const ingress = makeResource({
        kind: "Ingress",
        spec: {
          tls: [{ secretName: "tls-cert" }],
        },
      });
      const related = getRelatedResources(ingress, "ingresses");
      expect(related).toContainEqual({ kind: "Secret", name: "tls-cert", resourceType: "secrets" });
    });
  });

  describe("persistentvolumeclaims", () => {
    test("links to PV and StorageClass", () => {
      const pvc = makeResource({
        kind: "PersistentVolumeClaim",
        spec: { volumeName: "pv-1", storageClassName: "standard" },
      });
      const related = getRelatedResources(pvc, "persistentvolumeclaims");
      expect(related).toContainEqual({ kind: "PersistentVolume", name: "pv-1", resourceType: "persistentvolumes" });
      expect(related).toContainEqual({ kind: "StorageClass", name: "standard", resourceType: "storageclasses" });
    });
  });

  describe("persistentvolumes", () => {
    test("links to PVC via claimRef and StorageClass", () => {
      const pv = makeResource({
        kind: "PersistentVolume",
        spec: {
          claimRef: { name: "my-pvc", namespace: "default" },
          storageClassName: "fast",
        },
      });
      const related = getRelatedResources(pv, "persistentvolumes");
      expect(related).toContainEqual({ kind: "PersistentVolumeClaim", name: "my-pvc", resourceType: "persistentvolumeclaims" });
      expect(related).toContainEqual({ kind: "StorageClass", name: "fast", resourceType: "storageclasses" });
    });
  });

  describe("rolebindings", () => {
    test("links to roleRef and ServiceAccount subjects", () => {
      const rb = makeResource({
        kind: "RoleBinding",
        spec: {
          roleRef: { kind: "Role", name: "my-role" },
          subjects: [
            { kind: "ServiceAccount", name: "sa-1" },
            { kind: "User", name: "user-1" },
          ],
        },
      });
      const related = getRelatedResources(rb, "rolebindings");
      expect(related).toContainEqual({ kind: "Role", name: "my-role", resourceType: "roles" });
      expect(related).toContainEqual({ kind: "SA", name: "sa-1", resourceType: "" });
      // User subjects are not added
      expect(related.find((r) => r.name === "user-1")).toBeUndefined();
    });

    test("links ClusterRoleBinding to ClusterRole", () => {
      const crb = makeResource({
        kind: "ClusterRoleBinding",
        spec: {
          roleRef: { kind: "ClusterRole", name: "admin" },
          subjects: [],
        },
      });
      const related = getRelatedResources(crb, "clusterrolebindings");
      expect(related).toContainEqual({ kind: "ClusterRole", name: "admin", resourceType: "clusterroles" });
    });
  });

  describe("deduplication", () => {
    test("does not add the same related resource twice", () => {
      const pod = makeResource({
        spec: {
          volumes: [
            { configMap: { name: "shared-cm" } },
            { configMap: { name: "shared-cm" } },
          ],
          containers: [
            { envFrom: [{ configMapRef: { name: "shared-cm" } }] },
          ],
        },
      });
      const related = getRelatedResources(pod, "pods");
      const cmEntries = related.filter((r) => r.kind === "ConfigMap" && r.name === "shared-cm");
      expect(cmEntries).toHaveLength(1);
    });
  });

  describe("reverse service matching", () => {
    test("finds services whose selector matches resource labels", () => {
      const deploy = makeResource({
        kind: "Deployment",
        metadata: {
          ...makeResource().metadata,
          name: "my-deploy",
          labels: { app: "web", tier: "frontend" },
        },
      });
      const svc = makeResource({
        kind: "Service",
        metadata: { ...makeResource().metadata, name: "web-svc" },
        spec: { selector: { app: "web", tier: "frontend" } },
      });
      const related = getRelatedResources(deploy, "deployments", [svc]);
      expect(related).toContainEqual({ kind: "Service", name: "web-svc", resourceType: "services" });
    });

    test("does not match when selector partially matches", () => {
      const deploy = makeResource({
        kind: "Deployment",
        metadata: {
          ...makeResource().metadata,
          labels: { app: "web" },
        },
      });
      const svc = makeResource({
        kind: "Service",
        metadata: { ...makeResource().metadata, name: "web-svc" },
        spec: { selector: { app: "web", tier: "frontend" } },
      });
      const related = getRelatedResources(deploy, "deployments", [svc]);
      expect(related.find((r) => r.name === "web-svc")).toBeUndefined();
    });

    test("does not match non-matchable resource types", () => {
      const ingress = makeResource({
        kind: "Ingress",
        metadata: {
          ...makeResource().metadata,
          labels: { app: "web" },
        },
      });
      const svc = makeResource({
        kind: "Service",
        metadata: { ...makeResource().metadata, name: "web-svc" },
        spec: { selector: { app: "web" } },
      });
      const related = getRelatedResources(ingress, "ingresses", [svc]);
      expect(related.find((r) => r.name === "web-svc")).toBeUndefined();
    });

    test("does not match services with empty selector", () => {
      const pod = makeResource({
        metadata: {
          ...makeResource().metadata,
          labels: { app: "web" },
        },
      });
      const svc = makeResource({
        kind: "Service",
        metadata: { ...makeResource().metadata, name: "headless" },
        spec: { selector: {} },
      });
      const related = getRelatedResources(pod, "pods", [svc]);
      expect(related.find((r) => r.name === "headless")).toBeUndefined();
    });
  });
});
