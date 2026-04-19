import { describe, expect, test } from "bun:test";
import type { Resource } from "$lib/types";
import {
  SCALABLE_TYPES,
  RESTARTABLE_TYPES,
  LOG_TYPES,
  groupActions,
  getResourceUrl,
} from "./registry.logic";

// --- Action definitions (logic only, no icons/execute) for testing appliesTo ---

type ActionTier = "green" | "yellow" | "red";
type ActionGroup = "smart" | "navigate" | "operations" | "clipboard" | "destructive";

interface TestActionDef {
  id: string;
  label: string;
  tier: ActionTier;
  group: ActionGroup;
  priority: number;
  appliesTo: (resourceType: string, resource?: Resource) => boolean;
}

const resourceActions: TestActionDef[] = [
  { id: "view-logs", label: "View Logs", tier: "green", group: "navigate", priority: 10,
    appliesTo: (rt) => LOG_TYPES.includes(rt) },
  { id: "open-terminal", label: "Open Terminal", tier: "green", group: "navigate", priority: 20,
    appliesTo: (rt) => rt === "pods" },
  { id: "show-topology", label: "View Topology", tier: "green", group: "navigate", priority: 30,
    appliesTo: () => true },
  { id: "edit-yaml", label: "Edit YAML", tier: "green", group: "navigate", priority: 40,
    appliesTo: () => true },
  { id: "scale", label: "Scale Replicas...", tier: "yellow", group: "operations", priority: 10,
    appliesTo: (rt) => SCALABLE_TYPES.includes(rt) },
  { id: "restart", label: "Restart", tier: "yellow", group: "operations", priority: 20,
    appliesTo: (rt) => RESTARTABLE_TYPES.includes(rt) },
  { id: "rollback", label: "Rollback", tier: "yellow", group: "operations", priority: 30,
    appliesTo: (rt) => rt === "deployments" },
  { id: "open-in-browser", label: "Open in Browser", tier: "green", group: "operations", priority: 40,
    appliesTo: (rt) => rt === "services" || rt === "ingresses" },
  { id: "pin-resource", label: "Pin to Sidebar", tier: "green", group: "operations", priority: 60,
    appliesTo: () => true },
  { id: "copy-name", label: "Copy Name", tier: "green", group: "clipboard", priority: 10,
    appliesTo: () => true },
  { id: "copy-namespace", label: "Copy Namespace", tier: "green", group: "clipboard", priority: 20,
    appliesTo: (_, resource) => !!resource?.metadata.namespace },
  { id: "copy-yaml", label: "Copy as YAML", tier: "green", group: "clipboard", priority: 30,
    appliesTo: () => true },
  { id: "copy-json", label: "Copy as JSON", tier: "green", group: "clipboard", priority: 40,
    appliesTo: () => true },
  { id: "delete", label: "Delete", tier: "red", group: "destructive", priority: 100,
    appliesTo: () => true },
];

function getActionsForResource(resource: Resource): TestActionDef[] {
  const rt = resource.kind.toLowerCase() + "s";
  return resourceActions.filter((a) => a.appliesTo(rt, resource));
}

function makeResource(kind: string, overrides: Partial<Resource> = {}): Resource {
  return {
    kind,
    api_version: "v1",
    metadata: {
      name: "test-resource",
      namespace: "default",
      uid: "uid-123",
      creation_timestamp: "2024-01-01T00:00:00Z",
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

// === Tests ===

describe("constants from registry.logic", () => {
  test("SCALABLE_TYPES includes the right resource types", () => {
    expect(SCALABLE_TYPES).toContain("deployments");
    expect(SCALABLE_TYPES).toContain("statefulsets");
    expect(SCALABLE_TYPES).toContain("replicasets");
    expect(SCALABLE_TYPES).not.toContain("daemonsets");
  });

  test("RESTARTABLE_TYPES includes the right resource types", () => {
    expect(RESTARTABLE_TYPES).toContain("deployments");
    expect(RESTARTABLE_TYPES).toContain("statefulsets");
    expect(RESTARTABLE_TYPES).toContain("daemonsets");
    expect(RESTARTABLE_TYPES).not.toContain("replicasets");
  });

  test("LOG_TYPES includes pods and deployments", () => {
    expect(LOG_TYPES).toContain("pods");
    expect(LOG_TYPES).toContain("deployments");
  });
});

describe("getActionsForResource", () => {
  test("pod gets logs, terminal, topology, yaml, clipboard, delete", () => {
    const resource = makeResource("Pod");
    const actions = getActionsForResource(resource);
    const ids = actions.map((a) => a.id);

    expect(ids).toContain("view-logs");
    expect(ids).toContain("open-terminal");
    expect(ids).toContain("show-topology");
    expect(ids).toContain("edit-yaml");
    expect(ids).toContain("copy-name");
    expect(ids).toContain("delete");
  });

  test("pod does NOT get scale, restart, rollback", () => {
    const actions = getActionsForResource(makeResource("Pod"));
    const ids = actions.map((a) => a.id);
    expect(ids).not.toContain("scale");
    expect(ids).not.toContain("restart");
    expect(ids).not.toContain("rollback");
  });

  test("deployment gets scale, restart, rollback, logs", () => {
    const actions = getActionsForResource(makeResource("Deployment"));
    const ids = actions.map((a) => a.id);
    expect(ids).toContain("scale");
    expect(ids).toContain("restart");
    expect(ids).toContain("rollback");
    expect(ids).toContain("view-logs");
  });

  test("deployment does NOT get terminal", () => {
    const actions = getActionsForResource(makeResource("Deployment"));
    const ids = actions.map((a) => a.id);
    expect(ids).not.toContain("open-terminal");
  });

  test("statefulset gets scale and restart but not rollback", () => {
    const actions = getActionsForResource(makeResource("Statefulset"));
    const ids = actions.map((a) => a.id);
    expect(ids).toContain("scale");
    expect(ids).toContain("restart");
    expect(ids).not.toContain("rollback");
  });

  test("daemonset gets restart but not scale", () => {
    const actions = getActionsForResource(makeResource("Daemonset"));
    const ids = actions.map((a) => a.id);
    expect(ids).toContain("restart");
    expect(ids).not.toContain("scale");
    expect(ids).not.toContain("rollback");
  });

  test("service gets open-in-browser", () => {
    const actions = getActionsForResource(makeResource("Service"));
    const ids = actions.map((a) => a.id);
    expect(ids).toContain("open-in-browser");
  });

  test("ingress gets open-in-browser", () => {
    const actions = getActionsForResource(makeResource("Ingresse"));
    const ids = actions.map((a) => a.id);
    expect(ids).toContain("open-in-browser");
  });

  test("configmap gets only universal actions", () => {
    const actions = getActionsForResource(makeResource("Configmap"));
    const ids = actions.map((a) => a.id);
    expect(ids).toContain("show-topology");
    expect(ids).toContain("edit-yaml");
    expect(ids).toContain("copy-name");
    expect(ids).toContain("delete");
    expect(ids).not.toContain("view-logs");
    expect(ids).not.toContain("open-terminal");
    expect(ids).not.toContain("scale");
    expect(ids).not.toContain("restart");
  });

  test("resource without namespace hides copy-namespace", () => {
    const resource = makeResource("Pod", {
      metadata: {
        name: "test", namespace: undefined as unknown as string,
        uid: "uid-1", creation_timestamp: "2024-01-01T00:00:00Z",
        labels: {}, annotations: {}, owner_references: [], resource_version: "1",
      },
    });
    const actions = getActionsForResource(resource);
    const ids = actions.map((a) => a.id);
    expect(ids).not.toContain("copy-namespace");
  });

  test("all actions have valid tiers", () => {
    for (const action of resourceActions) {
      expect(["green", "yellow", "red"]).toContain(action.tier);
    }
  });

  test("all actions have unique ids", () => {
    const ids = resourceActions.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("groupActions (from registry.logic)", () => {
  test("groups actions by their group field", () => {
    const actions = [
      { group: "navigate", id: "a" },
      { group: "navigate", id: "b" },
      { group: "operations", id: "c" },
      { group: "destructive", id: "d" },
    ];
    const grouped = groupActions(actions);
    expect(grouped).toHaveLength(3);
    expect(grouped[0].group).toBe("navigate");
    expect(grouped[0].actions).toHaveLength(2);
    expect(grouped[1].group).toBe("operations");
    expect(grouped[2].group).toBe("destructive");
  });

  test("sorts groups by GROUP_ORDER", () => {
    const actions = [
      { group: "destructive", id: "z" },
      { group: "smart", id: "a" },
      { group: "clipboard", id: "x" },
      { group: "navigate", id: "b" },
    ];
    const grouped = groupActions(actions);
    const groupOrder = grouped.map((g) => g.group);
    expect(groupOrder).toEqual(["smart", "navigate", "clipboard", "destructive"]);
  });

  test("empty input returns empty array", () => {
    expect(groupActions([])).toHaveLength(0);
  });

  test("unknown groups sort to the end", () => {
    const actions = [
      { group: "navigate", id: "a" },
      { group: "custom", id: "b" },
    ];
    const grouped = groupActions(actions);
    expect(grouped[0].group).toBe("navigate");
    expect(grouped[1].group).toBe("custom");
  });
});

describe("getResourceUrl (from registry.logic)", () => {
  test("service with LoadBalancer IP returns URL", () => {
    const resource = makeResource("Service", {
      status: { loadBalancer: { ingress: [{ ip: "1.2.3.4" }] } },
      spec: { ports: [{ port: 8080 }] },
    });
    expect(getResourceUrl(resource)).toBe("http://1.2.3.4:8080");
  });

  test("service with LB hostname returns URL", () => {
    const resource = makeResource("Service", {
      status: { loadBalancer: { ingress: [{ hostname: "my-lb.example.com" }] } },
      spec: { ports: [{ port: 443 }] },
    });
    expect(getResourceUrl(resource)).toBe("http://my-lb.example.com");
  });

  test("service on port 80 omits port", () => {
    const resource = makeResource("Service", {
      status: { loadBalancer: { ingress: [{ ip: "1.2.3.4" }] } },
      spec: { ports: [{ port: 80 }] },
    });
    expect(getResourceUrl(resource)).toBe("http://1.2.3.4");
  });

  test("service without LB returns null", () => {
    const resource = makeResource("Service", { status: {}, spec: { ports: [{ port: 80 }] } });
    expect(getResourceUrl(resource)).toBeNull();
  });

  test("ingress with host returns http URL", () => {
    const resource = makeResource("Ingress", {
      spec: { rules: [{ host: "app.example.com" }] },
    });
    expect(getResourceUrl(resource)).toBe("http://app.example.com");
  });

  test("ingress with TLS returns https URL", () => {
    const resource = makeResource("Ingress", {
      spec: { rules: [{ host: "app.example.com" }], tls: [{ secretName: "tls-secret" }] },
    });
    expect(getResourceUrl(resource)).toBe("https://app.example.com");
  });

  test("ingress without host returns null", () => {
    const resource = makeResource("Ingress", { spec: { rules: [{}] } });
    expect(getResourceUrl(resource)).toBeNull();
  });

  test("ingress with empty rules returns null", () => {
    const resource = makeResource("Ingress", { spec: { rules: [] } });
    expect(getResourceUrl(resource)).toBeNull();
  });

  test("non-service/ingress returns null", () => {
    expect(getResourceUrl(makeResource("Pod"))).toBeNull();
    expect(getResourceUrl(makeResource("Deployment"))).toBeNull();
    expect(getResourceUrl(makeResource("ConfigMap"))).toBeNull();
  });
});
