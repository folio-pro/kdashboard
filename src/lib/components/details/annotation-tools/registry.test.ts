import { describe, expect, test } from "bun:test";
import { classifyAnnotations, stripPrefix } from "./registry";

describe("stripPrefix", () => {
  test("removes matching prefix", () => {
    expect(stripPrefix("getambassador.io/config", "getambassador.io/")).toBe("config");
  });

  test("returns full key when prefix does not match", () => {
    expect(stripPrefix("custom/key", "getambassador.io/")).toBe("custom/key");
  });
});

describe("classifyAnnotations", () => {
  test("returns empty array for empty annotations", () => {
    expect(classifyAnnotations({})).toEqual([]);
  });

  test("returns empty array for null annotations", () => {
    expect(classifyAnnotations(null as unknown as Record<string, string>)).toEqual([]);
  });

  test("returns empty array for undefined annotations", () => {
    expect(classifyAnnotations(undefined as unknown as Record<string, string>)).toEqual([]);
  });

  test("classifies Ambassador annotations", () => {
    const groups = classifyAnnotations({
      "getambassador.io/config": "some-config",
      "getambassador.io/ambassador-id": "default",
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].tool?.id).toBe("ambassador");
    expect(Object.keys(groups[0].annotations)).toHaveLength(2);
    expect(groups[0].shortKeys["getambassador.io/config"]).toBe("config");
    expect(groups[0].shortKeys["getambassador.io/ambassador-id"]).toBe("ambassador-id");
  });

  test("classifies mixed annotations into correct groups", () => {
    const groups = classifyAnnotations({
      "getambassador.io/config": "ambassador-value",
      "istio.io/rev": "1-18",
      "sidecar.istio.io/inject": "true",
      "custom-annotation": "custom-value",
    });

    expect(groups).toHaveLength(3); // Ambassador, Istio, Other

    // Istio has 2 annotations, Ambassador has 1 → Istio first
    expect(groups[0].tool?.id).toBe("istio");
    expect(Object.keys(groups[0].annotations)).toHaveLength(2);

    expect(groups[1].tool?.id).toBe("ambassador");
    expect(Object.keys(groups[1].annotations)).toHaveLength(1);

    // Other group is last
    expect(groups[2].tool).toBeNull();
    expect(groups[2].annotations["custom-annotation"]).toBe("custom-value");
  });

  test("longest prefix match: sidecar.istio.io/ beats istio.io/", () => {
    const groups = classifyAnnotations({
      "sidecar.istio.io/inject": "true",
      "istio.io/rev": "1-18",
    });

    // Both should go to the same Istio group
    expect(groups).toHaveLength(1);
    expect(groups[0].tool?.id).toBe("istio");
    expect(Object.keys(groups[0].annotations)).toHaveLength(2);

    // Verify the short keys use correct prefix stripping
    expect(groups[0].shortKeys["sidecar.istio.io/inject"]).toBe("inject");
    expect(groups[0].shortKeys["istio.io/rev"]).toBe("rev");
  });

  test("all unknown annotations go to Other group", () => {
    const groups = classifyAnnotations({
      "custom/annotation-1": "value-1",
      "another/annotation": "value-2",
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].tool).toBeNull();
    expect(Object.keys(groups[0].annotations)).toHaveLength(2);
  });

  test("sort order: count descending, then alphabetical", () => {
    const groups = classifyAnnotations({
      "getambassador.io/a": "1",
      "getambassador.io/b": "2",
      "getambassador.io/c": "3",
      "istio.io/a": "1",
      "prometheus.io/scrape": "true",
    });

    // Ambassador: 3, Istio: 1, Prometheus: 1
    expect(groups[0].tool?.id).toBe("ambassador");
    // Istio and Prometheus tied at 1 → alphabetical: Istio < Prometheus
    expect(groups[1].tool?.id).toBe("istio");
    expect(groups[2].tool?.id).toBe("prometheus");
  });

  test("Other group is always last regardless of count", () => {
    const groups = classifyAnnotations({
      "custom/a": "1",
      "custom/b": "2",
      "custom/c": "3",
      "custom/d": "4",
      "custom/e": "5",
      "istio.io/rev": "1-18",
    });

    // Other has 5, Istio has 1 — but Other is still last
    expect(groups).toHaveLength(2);
    expect(groups[0].tool?.id).toBe("istio");
    expect(groups[1].tool).toBeNull();
  });

  test("no duplicate assignment: each annotation in exactly one group", () => {
    const annotations: Record<string, string> = {
      "getambassador.io/config": "v1",
      "istio.io/rev": "1-18",
      "cert-manager.io/cluster-issuer": "letsencrypt",
      "custom/key": "value",
    };

    const groups = classifyAnnotations(annotations);

    const allKeys = groups.flatMap((g) => Object.keys(g.annotations));
    const uniqueKeys = new Set(allKeys);

    expect(allKeys.length).toBe(uniqueKeys.size);
    expect(allKeys.length).toBe(Object.keys(annotations).length);
  });

  test("handles kubectl.kubernetes.io/ prefix correctly", () => {
    const groups = classifyAnnotations({
      "kubectl.kubernetes.io/last-applied-configuration": "{}",
      "kubernetes.io/name": "test",
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].tool?.id).toBe("kubernetes");
    expect(Object.keys(groups[0].annotations)).toHaveLength(2);
    // kubectl.kubernetes.io/ matches kubernetes.io/ since kubectl.kubernetes.io/ is in the prefix list
    expect(groups[0].shortKeys["kubectl.kubernetes.io/last-applied-configuration"]).toBe(
      "last-applied-configuration"
    );
  });
});
