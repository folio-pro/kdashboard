// Pure helpers for the RBAC explorer panel.

import type { EffectivePermissions, Grant, PermissionRow, RbacSubject, SubjectKind } from "$lib/types";

export const VERBS = ["get", "list", "watch", "create", "update", "patch", "delete", "deletecollection"] as const;

export function subjectLabel(s: Pick<RbacSubject, "kind" | "name" | "namespace">): string {
  return s.kind === "ServiceAccount" ? `sa ${s.namespace ?? "?"}/${s.name}` : `${s.kind.toLowerCase()} ${s.name}`;
}

export function subjectKey(s: Pick<RbacSubject, "kind" | "name" | "namespace">): string {
  return `${s.kind}/${s.namespace ?? ""}/${s.name}`;
}

/** Subjects matching a free-text query, by name/namespace/kind. */
export function filterSubjects(subjects: readonly RbacSubject[], query: string, kind: SubjectKind | null): RbacSubject[] {
  const q = query.trim().toLowerCase();
  return subjects.filter((s) => (!kind || s.kind === kind) && (!q || `${s.kind} ${s.namespace ?? ""} ${s.name}`.toLowerCase().includes(q)));
}

/** Rows filtered by resource text and, optionally, scope. */
export function filterRows(rows: readonly PermissionRow[], query: string, scope: string | null): PermissionRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => (!scope || r.scopes.includes(scope)) && (!q || `${r.api_group}/${r.resource}`.toLowerCase().includes(q)));
}

/** Every scope a permission set touches, cluster first. */
export function scopesOf(perms: EffectivePermissions): string[] {
  const set = new Set<string>();
  for (const g of perms.grants) set.add(g.scope);
  return [...set].sort((a, b) => (a === "cluster" ? -1 : b === "cluster" ? 1 : a.localeCompare(b)));
}

/** Does the row allow `verb`? `*` counts. */
export function rowAllows(row: PermissionRow, verb: string): boolean {
  return row.verbs.includes("*") || row.verbs.includes(verb);
}

/**
 * Local "can-i": the grants that allow VERB on RESOURCE in NAMESPACE (null =
 * cluster-scoped question). Mirrors the backend canI so the check is instant.
 */
export function canI(perms: EffectivePermissions, verb: string, resource: string, apiGroup: string, namespace: string | null): Grant[] {
  return perms.grants.filter((g) => {
    if (g.scope !== "cluster" && (namespace === null || g.scope !== namespace)) return false;
    return g.rules.some(
      (r) =>
        (r.api_groups.includes("*") || r.api_groups.includes(apiGroup)) &&
        (r.resources.includes("*") || r.resources.includes(resource)) &&
        (r.verbs.includes("*") || r.verbs.includes(verb)),
    );
  });
}

/** "deploy" / "deployments.apps" / "apps/deployments" → { group, resource }. */
export function parseResourceRef(text: string): { apiGroup: string; resource: string } {
  const t = text.trim().toLowerCase();
  if (t.includes("/")) {
    const [group, resource] = t.split("/", 2);
    return { apiGroup: group, resource };
  }
  const dot = t.indexOf(".");
  if (dot > 0) return { apiGroup: t.slice(dot + 1), resource: t.slice(0, dot) };
  return { apiGroup: "", resource: t };
}
