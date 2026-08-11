import { describe, expect, test } from "bun:test";
import { filterGroups, resourceMatches, crdMatches } from "./sidebar-filter";

const SECTIONS = [
  { title: "Workloads", items: [{ name: "Pods", short: "po" }, { name: "Deployments", short: "deploy" }] },
  { title: "Network", items: [{ name: "Services", short: "svc" }, { name: "Ingresses", short: "ing" }] },
];

describe("filterGroups", () => {
  test("an empty query returns the input untouched", () => {
    expect(filterGroups(SECTIONS, "", resourceMatches)).toEqual(SECTIONS);
    expect(filterGroups(SECTIONS, "   ", resourceMatches)).toEqual(SECTIONS);
  });

  test("keeps only matching items and drops groups left empty", () => {
    const result = filterGroups(SECTIONS, "pod", resourceMatches);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Workloads");
    expect(result[0].items.map((i) => i.name)).toEqual(["Pods"]);
  });

  test("a matching group title keeps every child", () => {
    const result = filterGroups(SECTIONS, "network", resourceMatches);
    expect(result).toHaveLength(1);
    expect(result[0].items).toHaveLength(2);
  });

  test("matching is case-insensitive and trims the query", () => {
    expect(filterGroups(SECTIONS, "  PODS  ", resourceMatches)[0].items[0].name).toBe("Pods");
  });

  test("no match anywhere yields an empty list", () => {
    expect(filterGroups(SECTIONS, "zzz", resourceMatches)).toEqual([]);
  });

  test("does not mutate the input groups", () => {
    const before = JSON.parse(JSON.stringify(SECTIONS));
    filterGroups(SECTIONS, "pod", resourceMatches);
    expect(SECTIONS).toEqual(before);
  });
});

describe("resourceMatches", () => {
  test("matches on display name", () => {
    expect(resourceMatches({ name: "Deployments", short: "deploy" }, "deploym")).toBe(true);
  });

  test("matches on the kubectl short name — how people actually type", () => {
    expect(resourceMatches({ name: "Services", short: "svc" }, "svc")).toBe(true);
    expect(resourceMatches({ name: "Ingresses", short: "ing" }, "ing")).toBe(true);
  });

  test("tolerates a missing short name", () => {
    expect(resourceMatches({ name: "Pods" }, "pod")).toBe(true);
    expect(resourceMatches({ name: "Pods" }, "svc")).toBe(false);
  });
});

describe("crdMatches", () => {
  const crd = { kind: "Certificate", group: "cert-manager.io", plural: "certificates", short_names: ["cert"] };

  test("matches on kind", () => {
    expect(crdMatches(crd as never, "certif")).toBe(true);
  });

  test("matches on the first short name", () => {
    expect(crdMatches(crd as never, "cert")).toBe(true);
  });

  test("tolerates a CRD with no short names", () => {
    const bare = { ...crd, short_names: [] };
    expect(crdMatches(bare as never, "certificate")).toBe(true);
    expect(crdMatches(bare as never, "nope")).toBe(false);
  });
});
