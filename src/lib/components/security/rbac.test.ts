import { describe, expect, test } from "bun:test";
import type { EffectivePermissions, PermissionRow, RbacSubject } from "$lib/types";
import { canI, filterRows, filterSubjects, parseResourceRef, rowAllows, scopesOf, subjectLabel } from "./rbac.logic";

const subjects: RbacSubject[] = [
  { kind: "ServiceAccount", name: "ci", namespace: "billing", bindings: 2 },
  { kind: "User", name: "alice", namespace: null, bindings: 1 },
  { kind: "Group", name: "platform-admins", namespace: null, bindings: 1 },
];
const perms: EffectivePermissions = {
  subject: { kind: "ServiceAccount", name: "ci", namespace: "billing" },
  groups: [],
  grants: [
    { scope: "cluster", binding_kind: "ClusterRoleBinding", binding: "b", role_kind: "ClusterRole", role: "view", via: { kind: "Group", name: "g" }, rules: [{ api_groups: [""], resources: ["pods"], verbs: ["get", "list"], resource_names: [], non_resource_urls: [] }] },
    { scope: "billing", binding_kind: "RoleBinding", binding: "rb", role_kind: "Role", role: "deployer", via: { kind: "ServiceAccount", name: "ci" }, rules: [{ api_groups: ["apps"], resources: ["deployments"], verbs: ["*"], resource_names: [], non_resource_urls: [] }] },
  ],
  rows: [],
  cluster_admin: false,
  missing_roles: [],
};

describe("rbac panel helpers", () => {
  test("labels and filters subjects", () => {
    expect(subjectLabel(subjects[0])).toBe("sa billing/ci");
    expect(subjectLabel(subjects[1])).toBe("user alice");
    expect(filterSubjects(subjects, "bill", null).map((s) => s.name)).toEqual(["ci"]);
    expect(filterSubjects(subjects, "", "Group").map((s) => s.name)).toEqual(["platform-admins"]);
  });
  test("scopes and row filters", () => {
    expect(scopesOf(perms)).toEqual(["cluster", "billing"]);
    const rows: PermissionRow[] = [
      { api_group: "", resource: "pods", verbs: ["get"], scopes: ["cluster"], resource_names: null },
      { api_group: "apps", resource: "deployments", verbs: ["*"], scopes: ["billing"], resource_names: null },
    ];
    expect(filterRows(rows, "deploy", null).map((r) => r.resource)).toEqual(["deployments"]);
    expect(filterRows(rows, "", "cluster").map((r) => r.resource)).toEqual(["pods"]);
    expect(rowAllows(rows[1], "delete")).toBe(true);
    expect(rowAllows(rows[0], "delete")).toBe(false);
  });
  test("canI and resource refs", () => {
    expect(canI(perms, "list", "pods", "", "shop").map((g) => g.role)).toEqual(["view"]);
    expect(canI(perms, "delete", "deployments", "apps", "billing").map((g) => g.role)).toEqual(["deployer"]);
    expect(canI(perms, "delete", "deployments", "apps", "shop")).toEqual([]);
    expect(canI(perms, "list", "pods", "", null).map((g) => g.role)).toEqual(["view"]);
    expect(parseResourceRef("deployments.apps")).toEqual({ apiGroup: "apps", resource: "deployments" });
    expect(parseResourceRef("apps/deployments")).toEqual({ apiGroup: "apps", resource: "deployments" });
    expect(parseResourceRef("pods")).toEqual({ apiGroup: "", resource: "pods" });
  });
});
