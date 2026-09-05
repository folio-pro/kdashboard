// Unit tests for the Quick Action prompt builder (bun test).

import { describe, expect, test } from "bun:test";

import { buildQuickActionPrompt, quickActionsFor, QUICK_ACTIONS } from "./prompts";

const POD_CTX = {
  context: "kind-kdash-test",
  namespace: "kdash-test",
  kind: "Pod",
  name: "test-nginx-abc123",
};

describe("buildQuickActionPrompt", () => {
  test("every action embeds context, namespace, kind and name", () => {
    for (const action of QUICK_ACTIONS) {
      const prompt = buildQuickActionPrompt(action.id, POD_CTX);
      expect(prompt).toContain("kind-kdash-test");
      expect(prompt).toContain('namespace "kdash-test"');
      expect(prompt).toContain("Pod");
      expect(prompt).toContain("test-nginx-abc123");
      expect(prompt).toContain("MCP");
    }
  });

  test("cluster-scoped resources omit the namespace clause", () => {
    const prompt = buildQuickActionPrompt("ask-about", {
      context: "kind-kdash-test",
      kind: "Node",
      name: "worker-1",
    });
    expect(prompt).not.toContain("namespace");
    expect(prompt).toContain("worker-1");
  });

  test("curated actions state their task", () => {
    expect(buildQuickActionPrompt("analyze-logs", POD_CTX)).toContain("get_pod_logs");
    expect(buildQuickActionPrompt("why-crashing", POD_CTX)).toContain("root cause");
    expect(
      buildQuickActionPrompt("optimize-resources", { ...POD_CTX, kind: "Deployment", name: "test-nginx" }),
    ).toContain("update_container_resources");
    expect(
      buildQuickActionPrompt("diagnose-rollout", { ...POD_CTX, kind: "Deployment", name: "test-nginx" }),
    ).toContain("rollout");
  });

  test("the generic action is orientation only", () => {
    const prompt = buildQuickActionPrompt("ask-about", POD_CTX);
    expect(prompt.endsWith('"test-nginx-abc123" in namespace "kdash-test".')).toBe(true);
  });
});

describe("quickActionsFor", () => {
  test("pods get the two curated actions plus the generic one", () => {
    expect(quickActionsFor("pods").map((a) => a.id)).toEqual([
      "analyze-logs",
      "why-crashing",
      "ask-about",
    ]);
  });

  test("deployments get their curated actions plus the generic one", () => {
    expect(quickActionsFor("deployments").map((a) => a.id)).toEqual([
      "optimize-resources",
      "diagnose-rollout",
      "ask-about",
    ]);
  });

  test("everything else gets only the generic action", () => {
    expect(quickActionsFor("services").map((a) => a.id)).toEqual(["ask-about"]);
  });
});
