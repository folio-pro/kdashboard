// Unit tests for the Quick Action prompt builder (bun test).

import { describe, expect, test } from "bun:test";

import {
  PRESETS,
  QUICK_ACTIONS,
  buildAlertPrompt,
  buildLogsPrompt,
  buildPresetPrompt,
  buildProblemPrompt,
  buildProblemsSweepPrompt,
  buildQuickActionPrompt,
  quickActionsFor,
} from "./prompts";

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
  test("pods get the two curated actions plus the generic ones", () => {
    expect(quickActionsFor("pods").map((a) => a.id)).toEqual([
      "analyze-logs",
      "why-crashing",
      "explain",
      "ask-about",
    ]);
  });

  test("deployments get their curated actions plus the generic ones", () => {
    expect(quickActionsFor("deployments").map((a) => a.id)).toEqual([
      "optimize-resources",
      "diagnose-rollout",
      "explain",
      "ask-about",
    ]);
  });

  test("services get the connectivity check plus the generic ones", () => {
    expect(quickActionsFor("services").map((a) => a.id)).toEqual(["check-connectivity", "explain", "ask-about"]);
  });

  test("a resource type with nothing curated still gets explain + ask", () => {
    expect(quickActionsFor("configmaps").map((a) => a.id)).toEqual(["explain", "ask-about"]);
  });
});

describe("presets and contextual prompts", () => {
  const ctx = { context: "kind-kdash-test" };

  test("namespace-scoped presets only exist with a namespace", () => {
    expect(PRESETS.find((p) => p.id === "namespace-health")?.needsNamespace).toBe(true);
    expect(buildPresetPrompt("namespace-health", { ...ctx, namespace: "shop" })).toContain('namespace "shop"');
    expect(buildPresetPrompt("cluster-health", ctx)).toContain("list_problems");
  });

  test("a problem prompt carries kdashboard's verdict", () => {
    const prompt = buildProblemPrompt(ctx, {
      kind: "Deployment",
      name: "api",
      namespace: "shop",
      reason: "CrashLoopBackOff",
      detail: "back-off restarting failed container",
      owner: null,
      restarts: 12,
    });
    expect(prompt).toContain('Deployment "api" in namespace "shop"');
    expect(prompt).toContain("CrashLoopBackOff (back-off restarting failed container), 12 restarts");
    expect(prompt).toContain("previous=true");
  });

  test("the sweep prompt states the scope and count", () => {
    expect(buildProblemsSweepPrompt({ ...ctx, namespace: "shop" }, 3)).toContain('3 problems in namespace "shop"');
    expect(buildProblemsSweepPrompt(ctx, 1)).toContain("1 problem in the whole cluster");
  });

  test("an alert prompt names the watched resource and the alert", () => {
    const prompt = buildAlertPrompt(ctx, { kind: "Pod", name: "web-1", namespace: "shop" }, { title: "web-1 is CrashLoopBackOff", body: "3 restarts" });
    expect(prompt).toContain('Pod "web-1" in namespace "shop"');
    expect(prompt).toContain("3 restarts");
  });

  test("a logs prompt carries the viewer's filter so the agent can grep", () => {
    const prompt = buildLogsPrompt(ctx, {
      namespace: "shop",
      kind: "Pod",
      name: "web-1",
      container: "app",
      filterText: "timeout",
      level: "error",
      previous: true,
    });
    expect(prompt).toContain('pod "web-1" (container "app")');
    expect(prompt).toContain('"timeout"');
    expect(prompt).toContain("grep");
    expect(prompt).toContain('level "error"');
    expect(prompt).toContain("previous=true");
    const regex = buildLogsPrompt(ctx, { namespace: "shop", kind: "Deployment", name: "web", filterText: "err.*", useRegex: true });
    expect(regex).toContain("/err.*/");
    expect(regex).toContain("list_resources pods");
    // A deployment view narrowed to one pod targets that pod, not all of them.
    const one = buildLogsPrompt(ctx, { namespace: "shop", kind: "Deployment", name: "web", pod: "web-abc" });
    expect(one).toContain('the pod "web-abc" of the Deployment "web"');
    expect(one).not.toContain("list_resources pods");
  });
});
