import { test, expect, describe } from "bun:test";

import { RESOURCE_ITEMS, CLUSTER_SCOPED_TYPES, isClusterScopedType, resourceTypeLabel } from "./resource-catalog";
// The backend registry is the source of truth for scope; bunfig pins the test
// root to src, so it is reached by relative path.
import { RESOURCE_TYPES } from "../../electron/k8s/kinds";

describe("resourceTypeLabel", () => {
  test("uses the name the sidebar shows, not a capitalized type", () => {
    // The acronyms are the reason this exists: capitalizing the type spelled
    // them "Hpa"/"Wpa", which is not what the sidebar entry beside them says.
    expect(resourceTypeLabel("hpa")).toBe("HPA");
    expect(resourceTypeLabel("vpa")).toBe("VPA");
    expect(resourceTypeLabel("wpa")).toBe("WPA");
    expect(resourceTypeLabel("persistentvolumeclaims")).toBe("Persistent Volume Claims");
    expect(resourceTypeLabel("pods")).toBe("Pods");
  });

  test("capitalizes anything outside the catalog, so a CRD view still reads", () => {
    expect(resourceTypeLabel("widgets")).toBe("Widgets");
    expect(resourceTypeLabel("")).toBe("");
  });

  test("covers every catalog entry", () => {
    for (const item of RESOURCE_ITEMS) {
      expect(resourceTypeLabel(item.type)).toBe(item.name);
    }
  });
});

describe("clusterScoped", () => {
  test("every listable catalog entry agrees with the backend registry", () => {
    for (const item of RESOURCE_ITEMS) {
      if (item.virtual) continue;
      const entry = RESOURCE_TYPES[item.type];
      expect(entry, `${item.type} is not in RESOURCE_TYPES`).toBeDefined();
      expect(!!item.clusterScoped, `${item.type}: catalog clusterScoped != registry`).toBe(entry.clusterScoped);
    }
  });

  test("isClusterScopedType reads the flag, and is false outside the catalog", () => {
    expect(isClusterScopedType("nodes")).toBe(true);
    expect(isClusterScopedType("clusterrolebindings")).toBe(true);
    expect(isClusterScopedType("pods")).toBe(false);
    expect(isClusterScopedType("crd:demo.kdash.io/Widget")).toBe(false);
    expect(isClusterScopedType("topology")).toBe(false);
    expect(CLUSTER_SCOPED_TYPES.size).toBe(
      Object.values(RESOURCE_TYPES).filter((e) => e.clusterScoped).length,
    );
  });
});
