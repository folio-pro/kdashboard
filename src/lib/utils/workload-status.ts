// What a Deployment row says about itself beyond three replica counts: one
// status word derived from its conditions, the replica count split into the
// segments a bar can paint, and the images its template runs. Pure.

import type { Resource } from "$lib/types";

type Json = Record<string, unknown>;

interface Condition {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
}

/** ok = healthy or deliberately idle · transient = on its way · bad = needs a look. */
export type StatusTone = "ok" | "transient" | "bad";

export interface WorkloadStatus {
  /** "Available" · "Progressing" · "Unavailable" · "Paused" · "Scaled to 0" · "Failed" · "ReplicaFailure" · "2/3 ready" · "NotReady" … */
  label: string;
  /** The condition reason behind a non-healthy label (MinimumReplicasUnavailable, ProgressDeadlineExceeded…). */
  detail?: string;
  tone: StatusTone;
}

function conditions(resource: Resource): Condition[] {
  const list = (resource.status as Json | undefined)?.conditions;
  return Array.isArray(list) ? (list as Condition[]) : [];
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * The Deployment's state, in the order an operator cares: paused and scaled
 * to zero are deliberate; a failed rollout or unavailable replicas need a
 * look; a rollout in progress is transient; otherwise it is simply available.
 */
export function deploymentStatus(resource: Resource): WorkloadStatus {
  const spec = (resource.spec ?? {}) as Json;
  const status = (resource.status ?? {}) as Json;
  const desired = spec.replicas === undefined ? 1 : num(spec.replicas);
  const ready = num(status.readyReplicas);
  const updated = num(status.updatedReplicas);
  const current = num(status.replicas);
  const cond = (type: string) => conditions(resource).find((c) => c.type === type);

  if (spec.paused === true) return { label: "Paused", tone: "ok" };
  if (desired === 0) return { label: "Scaled to 0", tone: "ok" };

  const failure = cond("ReplicaFailure");
  if (failure?.status === "True") return { label: "ReplicaFailure", detail: failure.reason, tone: "bad" };
  const progressing = cond("Progressing");
  if (progressing?.status === "False") return { label: "Failed", detail: progressing.reason, tone: "bad" };
  const available = cond("Available");
  if (available?.status === "False") return { label: "Unavailable", detail: available.reason, tone: "bad" };

  if (updated < desired || current > desired || ready < desired) {
    return { label: "Progressing", detail: progressing?.reason, tone: "transient" };
  }
  return { label: "Available", tone: "ok" };
}

/** StatefulSet: ready against desired; scaled to zero is deliberate. */
export function statefulSetStatus(resource: Resource): WorkloadStatus {
  const spec = (resource.spec ?? {}) as Json;
  const status = (resource.status ?? {}) as Json;
  const desired = spec.replicas === undefined ? 1 : num(spec.replicas);
  const ready = num(status.readyReplicas);
  if (desired === 0) return { label: "Scaled to 0", tone: "ok" };
  return { label: `${ready}/${desired} ready`, tone: ready >= desired ? "ok" : "bad" };
}

/** DaemonSet: available against desired; a misscheduled pod is wrong by definition. */
export function daemonSetStatus(resource: Resource): WorkloadStatus {
  const status = (resource.status ?? {}) as Json;
  const desired = num(status.desiredNumberScheduled);
  const available = num(status.numberAvailable);
  const mis = num(status.numberMisscheduled);
  if (mis > 0) return { label: "Misscheduled", detail: `${mis} pod${mis === 1 ? "" : "s"} on nodes they should not run on`, tone: "bad" };
  if (desired > 0 && available < desired) return { label: `${available}/${desired} available`, tone: "bad" };
  return { label: `${available}/${desired} available`, tone: "ok" };
}

/** Job: Failed condition or failed pods; Complete; else running or waiting. */
export function jobStatus(resource: Resource): WorkloadStatus {
  const status = (resource.status ?? {}) as Json;
  const cond = (type: string) => conditions(resource).find((c) => c.type === type && c.status === "True");
  const failed = cond("Failed");
  if (failed || num(status.failed) > 0) return { label: "Failed", detail: failed?.reason, tone: "bad" };
  if (cond("Complete")) return { label: "Complete", tone: "ok" };
  return { label: num(status.active) > 0 ? "Running" : "Pending", tone: "transient" };
}

/** Node: Ready, then any pressure condition that is true. */
export function nodeStatus(resource: Resource): WorkloadStatus {
  const conds = conditions(resource);
  const ready = conds.find((c) => c.type === "Ready");
  if (!ready || ready.status !== "True") return { label: "NotReady", detail: ready?.reason, tone: "bad" };
  const pressure = conds.find((c) => (c.type ?? "").endsWith("Pressure") && c.status === "True");
  if (pressure) return { label: pressure.type ?? "Pressure", detail: pressure.reason, tone: "bad" };
  return { label: "Ready", tone: "ok" };
}

/** One verdict for any kind this module knows; null for kinds without a notion of health. */
export function workloadStatus(resource: Resource): WorkloadStatus | null {
  switch (resource.kind) {
    case "Deployment": return deploymentStatus(resource);
    case "StatefulSet": return statefulSetStatus(resource);
    case "DaemonSet": return daemonSetStatus(resource);
    case "Job": return jobStatus(resource);
    case "Node": return nodeStatus(resource);
    default: return null;
  }
}

export interface ReplicaSegments {
  desired: number;
  /** Pods that are ready. */
  ready: number;
  /** Pods that exist but are not ready yet (creating, starting, failing probes). */
  pending: number;
  /** Pods the controller has not created yet (or that are missing). */
  missing: number;
}

/**
 * The Ready cell's bar: ready, then pods that exist but are not ready, then
 * the gap to the desired count. Works for Deployments, ReplicaSets and
 * StatefulSets (`spec.replicas` / `status.readyReplicas` / `status.replicas`).
 */
export function replicaSegments(resource: Resource): ReplicaSegments {
  const spec = (resource.spec ?? {}) as Json;
  const status = (resource.status ?? {}) as Json;
  const desired = spec.replicas === undefined ? 1 : num(spec.replicas);
  const ready = num(status.readyReplicas);
  const current = num(status.replicas);
  const pending = Math.max(0, current - ready);
  const missing = Math.max(0, desired - ready - pending);
  return { desired, ready, pending, missing };
}

/**
 * `ghcr.io/shop/api:2.4.1` → `api:2.4.1`; a digest-pinned image keeps a short
 * digest instead of a tag. The registry and path are in the tooltip.
 */
export function shortImage(image: string): string {
  let ref = image;
  let digest = "";
  const at = ref.indexOf("@");
  if (at !== -1) {
    digest = ref.slice(at + 1);
    ref = ref.slice(0, at);
  }
  const lastSlash = ref.lastIndexOf("/");
  const name = lastSlash === -1 ? ref : ref.slice(lastSlash + 1);
  if (digest) {
    // A digest pin is the identity even when a tag rides along: keep both.
    const hex = digest.replace(/^sha256:/, "");
    return `${name}@${hex.slice(0, 7)}`;
  }
  return name;
}

/** Images of the pod template's containers, in order (init containers excluded). */
export function templateImages(resource: Resource): string[] {
  const spec = (resource.spec ?? {}) as Json;
  const template = spec.template as { spec?: { containers?: Array<{ image?: string }> } } | undefined;
  const containers = template?.spec?.containers ?? [];
  return containers.map((c) => c.image).filter((i): i is string => typeof i === "string" && i !== "");
}
