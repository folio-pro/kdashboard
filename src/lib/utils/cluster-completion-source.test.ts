import { describe, expect, test } from "bun:test";

import {
  clusterSourceFor,
  _BY_KEY as BY_KEY,
  _BY_PARENT_AND_KEY as BY_PARENT_AND_KEY,
  _TTL_MS as TTL_MS,
} from "./cluster-completion-source";

describe("clusterSourceFor", () => {
  test("resolves serviceAccountName to ServiceAccounts", () => {
    const found = clusterSourceFor(["spec", "serviceAccountName"]);
    expect(found?.resourceType).toBe("serviceaccounts");
  });

  test("resolves namespace to the namespace list", () => {
    expect(clusterSourceFor(["metadata", "namespace"])?.resourceType).toBe("namespaces");
  });

  test("resolves secretKeyRef.name to Secrets", () => {
    const path = ["spec", "containers", 0, "env", 1, "valueFrom", "secretKeyRef", "name"];
    expect(clusterSourceFor(path)?.resourceType).toBe("secrets");
  });

  test("resolves configMapKeyRef.name to ConfigMaps", () => {
    const path = ["spec", "containers", 0, "env", 0, "valueFrom", "configMapKeyRef", "name"];
    expect(clusterSourceFor(path)?.resourceType).toBe("configmaps");
  });

  test("resolves a volume's configMap.name to ConfigMaps", () => {
    expect(clusterSourceFor(["spec", "volumes", 0, "configMap", "name"])?.resourceType).toBe(
      "configmaps",
    );
  });

  test("resolves a volume's secret.secretName to Secrets", () => {
    expect(clusterSourceFor(["spec", "volumes", 0, "secret", "secretName"])?.resourceType).toBe(
      "secrets",
    );
  });

  test("resolves persistentVolumeClaim.claimName to PVCs", () => {
    const path = ["spec", "volumes", 0, "persistentVolumeClaim", "claimName"];
    expect(clusterSourceFor(path)?.resourceType).toBe("persistentvolumeclaims");
  });

  test("skips array indices when looking for the parent", () => {
    // The nearest string ancestor of `name` here is `secretKeyRef`, not the
    // numeric index sitting between them.
    const path = ["env", 3, "valueFrom", "secretKeyRef", "name"];
    expect(clusterSourceFor(path)?.detail).toBe("Secret");
  });

  test("a bare metadata.name is not a reference", () => {
    expect(clusterSourceFor(["metadata", "name"])).toBeNull();
  });

  test("a container name is not a reference", () => {
    expect(clusterSourceFor(["spec", "containers", 0, "name"])).toBeNull();
  });

  test("an unrelated field is not a reference", () => {
    expect(clusterSourceFor(["spec", "replicas"])).toBeNull();
  });

  test("an empty path is not a reference", () => {
    expect(clusterSourceFor([])).toBeNull();
  });

  test("a numeric leaf is not a reference", () => {
    expect(clusterSourceFor(["spec", "ports", 0])).toBeNull();
  });
});

describe("scoping", () => {
  test("cluster-scoped kinds are marked as such", () => {
    expect(BY_KEY.nodeName.clusterScoped).toBe(true);
    expect(BY_KEY.storageClassName.clusterScoped).toBe(true);
  });

  test("namespaced kinds are not marked cluster-scoped", () => {
    expect(BY_KEY.serviceAccountName.clusterScoped).toBeUndefined();
  });

  test("every parent-and-key entry names a resource type", () => {
    for (const source of Object.values(BY_PARENT_AND_KEY)) {
      expect(source.resourceType).not.toBe("");
      expect(source.detail).not.toBe("");
    }
  });

  test("every key entry names a resource type", () => {
    for (const source of Object.values(BY_KEY)) {
      expect(source.resourceType).not.toBe("");
    }
  });
});

describe("cache policy", () => {
  test("the TTL is short enough to notice new objects", () => {
    expect(TTL_MS).toBeLessThanOrEqual(60_000);
  });

  test("the TTL is long enough to survive typing a block", () => {
    expect(TTL_MS).toBeGreaterThanOrEqual(5_000);
  });
});
