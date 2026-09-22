import { describe, expect, test } from "bun:test";
import type { Resource } from "$lib/types";
import { nodePodsListArgs, podsOnNode } from "./node-pods";

function pod(name: string, namespace: string, nodeName?: string): Resource {
  return {
    api_version: "v1",
    kind: "Pod",
    metadata: { name, namespace, uid: `${namespace}/${name}`, creation_timestamp: "" },
    spec: nodeName === undefined ? {} : { nodeName },
    status: {},
  } as unknown as Resource;
}

describe("nodePodsListArgs", () => {
  test("lists pods cluster-wide with a spec.nodeName field selector", () => {
    expect(nodePodsListArgs("node-a")).toEqual({
      resourceType: "pods",
      namespace: null,
      fieldSelector: "spec.nodeName=node-a",
    });
  });
});

describe("podsOnNode", () => {
  test("keeps only the node's pods (safety net over the server filter)", () => {
    const items = [pod("a", "ns1", "node-a"), pod("b", "ns1", "node-b"), pod("c", "ns1")];
    expect(podsOnNode(items, "node-a").map((p) => p.metadata.name)).toEqual(["a"]);
  });

  test("sorts by namespace then name", () => {
    const items = [
      pod("z", "kube-system", "n"),
      pod("b", "default", "n"),
      pod("a", "kube-system", "n"),
      pod("a", "default", "n"),
    ];
    expect(podsOnNode(items, "n").map((p) => `${p.metadata.namespace}/${p.metadata.name}`)).toEqual([
      "default/a",
      "default/b",
      "kube-system/a",
      "kube-system/z",
    ]);
  });

  test("does not mutate the input", () => {
    const items = [pod("b", "ns", "n"), pod("a", "ns", "n")];
    podsOnNode(items, "n");
    expect(items.map((p) => p.metadata.name)).toEqual(["b", "a"]);
  });
});
