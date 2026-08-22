// Quick edit — pure logic. Edits the parts of a workload people change most
// (image tags, env vars, requests/limits) on the object's own YAML, so the
// result goes through the same server-side apply as the YAML editor.

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface EnvEdit {
  name: string;
  /** Literal value. Null when the entry takes its value from a valueFrom ref (read-only here). */
  value: string | null;
  fromRef: boolean;
}

export interface ContainerEdit {
  name: string;
  image: string;
  env: EnvEdit[];
  cpu_request: string;
  memory_request: string;
  cpu_limit: string;
  memory_limit: string;
}

export interface QuickEdit {
  kind: string;
  name: string;
  namespace: string;
  containers: ContainerEdit[];
}

type Json = Record<string, unknown>;

interface RawContainer {
  name?: string;
  image?: string;
  env?: Array<{ name: string; value?: string; valueFrom?: unknown }>;
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
  [k: string]: unknown;
}

/** Where the pod template's containers live for each kind. */
function containersPath(doc: Json): RawContainer[] | null {
  const kind = doc.kind;
  const spec = doc.spec as Json | undefined;
  if (!spec) return null;
  if (kind === "Pod") return ((spec.containers as RawContainer[] | undefined) ?? null);
  if (kind === "CronJob") {
    const tpl = ((spec.jobTemplate as Json | undefined)?.spec as Json | undefined)?.template as Json | undefined;
    return ((tpl?.spec as Json | undefined)?.containers as RawContainer[] | undefined) ?? null;
  }
  const tpl = spec.template as Json | undefined;
  return ((tpl?.spec as Json | undefined)?.containers as RawContainer[] | undefined) ?? null;
}

/** The editable fields, read off the object's YAML. */
export function quickEditFromYaml(yaml: string): QuickEdit {
  const doc = parseYaml(yaml) as Json;
  const meta = (doc.metadata ?? {}) as Json;
  const containers = containersPath(doc) ?? [];
  return {
    kind: String(doc.kind ?? ""),
    name: String(meta.name ?? ""),
    namespace: String(meta.namespace ?? ""),
    containers: containers.map((c) => ({
      name: c.name ?? "",
      image: c.image ?? "",
      env: (c.env ?? []).map((e) => ({ name: e.name, value: e.valueFrom ? null : (e.value ?? ""), fromRef: !!e.valueFrom })),
      cpu_request: c.resources?.requests?.cpu ?? "",
      memory_request: c.resources?.requests?.memory ?? "",
      cpu_limit: c.resources?.limits?.cpu ?? "",
      memory_limit: c.resources?.limits?.memory ?? "",
    })),
  };
}

function setQuantity(bag: Record<string, string> | undefined, key: string, value: string): Record<string, string> | undefined {
  const next = { ...(bag ?? {}) };
  if (value.trim()) next[key] = value.trim();
  else delete next[key];
  return Object.keys(next).length ? next : undefined;
}

/**
 * Apply the edits to the YAML and return the new document. Untouched fields
 * keep their exact values; a cleared request/limit is dropped; env entries
 * are rewritten as a whole list (literal ones from the form, valueFrom ones
 * preserved verbatim in place).
 */
export function applyQuickEdit(yaml: string, edit: QuickEdit): string {
  const doc = parseYaml(yaml) as Json;
  const containers = containersPath(doc);
  if (!containers) throw new Error(`${edit.kind || "This kind"} has no pod template to edit`);
  for (const c of containers) {
    const e = edit.containers.find((x) => x.name === c.name);
    if (!e) continue;
    if (e.image.trim()) c.image = e.image.trim();
    const original = c.env ?? [];
    const rebuilt: Array<{ name: string; value?: string; valueFrom?: unknown }> = [];
    for (const ev of e.env) {
      if (!ev.name.trim()) continue;
      if (ev.fromRef) {
        const orig = original.find((o) => o.name === ev.name);
        if (orig) rebuilt.push(orig);
      } else {
        rebuilt.push({ name: ev.name.trim(), value: ev.value ?? "" });
      }
    }
    if (rebuilt.length) c.env = rebuilt;
    else delete c.env;
    const resources = { ...(c.resources ?? {}) } as { requests?: Record<string, string>; limits?: Record<string, string> };
    let requests = setQuantity(resources.requests, "cpu", e.cpu_request);
    requests = setQuantity(requests, "memory", e.memory_request);
    let limits = setQuantity(resources.limits, "cpu", e.cpu_limit);
    limits = setQuantity(limits, "memory", e.memory_limit);
    if (requests) resources.requests = requests; else delete resources.requests;
    if (limits) resources.limits = limits; else delete resources.limits;
    if (Object.keys(resources).length) c.resources = resources; else delete c.resources;
  }
  return stringifyYaml(doc, { lineWidth: 0 });
}

/** Human summary of what changed, for the confirm step. */
export function describeChanges(before: QuickEdit, after: QuickEdit): string[] {
  const out: string[] = [];
  for (const a of after.containers) {
    const b = before.containers.find((x) => x.name === a.name);
    if (!b) continue;
    if (a.image.trim() && a.image.trim() !== b.image) out.push(`${a.name}: image ${b.image} → ${a.image.trim()}`);
    const bEnv = new Map(b.env.map((e) => [e.name, e]));
    const aEnv = new Map(a.env.filter((e) => e.name.trim()).map((e) => [e.name.trim(), e]));
    for (const [name, e] of aEnv) {
      const prev = bEnv.get(name);
      if (!prev) out.push(`${a.name}: env ${name} added`);
      else if (!e.fromRef && prev.value !== e.value) out.push(`${a.name}: env ${name} changed`);
    }
    for (const name of bEnv.keys()) if (!aEnv.has(name)) out.push(`${a.name}: env ${name} dropped`);
    for (const [label, key] of [["CPU request", "cpu_request"], ["memory request", "memory_request"], ["CPU limit", "cpu_limit"], ["memory limit", "memory_limit"]] as const) {
      if (a[key].trim() !== b[key].trim()) out.push(`${a.name}: ${label} ${b[key] || "unset"} → ${a[key].trim() || "unset"}`);
    }
  }
  return out;
}

export const QUICK_EDIT_TYPES = ["deployments", "statefulsets", "daemonsets", "cronjobs"];
