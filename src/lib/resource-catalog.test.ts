import { test, expect, describe } from "bun:test";

import { RESOURCE_ITEMS, resourceTypeLabel } from "./resource-catalog";

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
