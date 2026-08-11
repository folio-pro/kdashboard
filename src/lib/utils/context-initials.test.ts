import { describe, expect, test } from "bun:test";
import { contextInitials } from "./context-initials";

describe("contextInitials", () => {
  test("takes one character per meaningful segment", () => {
    expect(contextInitials("prod-eu-west")).toBe("PEW");
    expect(contextInitials("staging_api")).toBe("SA");
  });

  test("caps at three characters", () => {
    expect(contextInitials("a-b-c-d-e")).toBe("ABC");
  });

  test("drops filler segments that every context shares", () => {
    expect(contextInitials("ovh-k8s")).toBe("OV");
    expect(contextInitials("kubernetes-admin@prod")).toBe("PR");
    expect(contextInitials("my-cluster-context")).toBe("MY");
  });

  test("uses the trailing path segment of ARN-style names", () => {
    expect(contextInitials("arn:aws:eks:eu-west-1:123:cluster/payments-prod")).toBe("PP");
  });

  test("single segment yields two characters", () => {
    expect(contextInitials("minikube")).toBe("MI");
  });

  test("a trailing digit disambiguates same-prefix contexts", () => {
    expect(contextInitials("prod2")).toBe("P2");
    expect(contextInitials("prod3")).toBe("P3");
  });

  test("falls back rather than returning empty", () => {
    expect(contextInitials("")).toBe("?");
    expect(contextInitials("---")).toBe("?");
  });

  test("the eleven-context rail from the screenshot stops collapsing to one letter", () => {
    const contexts = [
      "docker-desktop", "gke-prod", "gke-staging", "kind-local", "kind-test",
      "ovh-k8s", "ovh-backup", "prod-eu", "prod-us", "preprod-eu", "preprod-us",
    ];
    const before = new Set(contexts.map((c) => c[0].toUpperCase())).size;
    const after = new Set(contexts.map(contextInitials)).size;

    expect(before).toBe(5); // d, g, k, o, p — eleven clusters, five badges
    expect(after).toBe(9);
    expect(after).toBeGreaterThan(before);
  });

  test("initials alone cannot guarantee uniqueness, and don't claim to", () => {
    // prod-eu and preprod-eu both reduce to PE. The rail pairs the badge with
    // a per-context colour and a tooltip carrying the full name, so this is a
    // documented limit rather than a defect — but callers must not assume the
    // badge is an identifier.
    expect(contextInitials("prod-eu")).toBe(contextInitials("preprod-eu"));
  });
});
