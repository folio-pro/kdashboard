// Why is this pod broken? One analysis shared by the cluster overview
// (Problem.cause / Problem.pod / detail) and diagnose_resource (issue titles
// and suggestions), so the Problems list and its diagnosis panel never
// disagree about the same pod. Pure: typed k8s objects in, judgement out.

import type { V1Pod } from '@kubernetes/client-node';

/**
 * Machine-readable category the UI keys its actions on: a restart helps a
 * crash, not a missing secret.
 */
export type ProblemCause =
  | 'image-pull'
  | 'config'
  | 'crash'
  | 'oom'
  | 'unschedulable'
  | 'progress-deadline'
  | 'job-failed'
  | 'pvc-pending'
  | 'no-endpoints'
  | 'lb-pending'
  | 'unknown';

/** The most relevant pod behind a problem — where "open pod" / "view logs" should land. */
export interface PodRef {
  name: string;
  namespace: string;
  container: string | null;
}

export interface PodCause {
  cause: ProblemCause;
  severity: 'critical' | 'warning';
  /** Short reason as Kubernetes names it: ImagePullBackOff, Unschedulable, ExitCode 2… */
  reason: string;
  /** `container app — back-off 5m` style; null when there is nothing beyond the reason. */
  detail: string | null;
  /** What to do about it, worded for the cause. */
  suggestion: string;
  pod: PodRef;
  restarts: number;
  /** Exit code of the last termination, when the container has ever exited. */
  exitCode: number | null;
  /** ISO timestamp to date the problem from. */
  since: string | null;
}

// Mirror of src/lib/utils/pod-status.ts BROKEN_REASON / podProblem — edit both together.
export const BROKEN_REASON = /error|crash|backoff|oom|invalid|cannotrun|deadline|killed/i;

export function iso(d: Date | string | undefined | null): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Cause from a container's waiting/terminated reason. The last termination
 * matters for a CrashLoopBackOff: a loop of OOMKills is a memory problem,
 * not a crash.
 */
export function classifyCause(reason: string | undefined, lastTerminatedReason?: string | undefined): ProblemCause {
  const r = reason ?? '';
  if (/ImagePull|ErrImage|InvalidImageName/i.test(r)) return 'image-pull';
  if (/CreateContainerConfigError/i.test(r)) return 'config';
  if (/OOMKilled/i.test(r) || /OOMKilled/i.test(lastTerminatedReason ?? '')) return 'oom';
  if (/CrashLoopBackOff|ContainerCannotRun|RunContainerError|CreateContainerError|DeadlineExceeded|^Error$|^ExitCode/i.test(r)) return 'crash';
  if (/Unschedulable|SchedulerError/i.test(r)) return 'unschedulable';
  return 'unknown';
}

interface SuggestionContext {
  container: string | null;
  namespace: string;
  image?: string | null;
  message?: string | null;
  exitCode?: number | null;
  lastReason?: string | null;
  memoryLimit?: string | null;
}

export function suggestionFor(cause: ProblemCause, ctx: SuggestionContext): string {
  const message = ctx.message?.trim() ?? '';
  switch (cause) {
    case 'image-pull':
      return `Check the image name and tag${ctx.image ? ` (${ctx.image})` : ''} and the registry credentials (imagePullSecrets).`;
    case 'config': {
      const missing = /(secret|configmap) "([^"]+)" not found/i.exec(message);
      if (missing) return `Create ${missing[1].toLowerCase()} "${missing[2]}" in namespace "${ctx.namespace}" or fix the reference in the pod spec.`;
      const key = /couldn't find key (\S+) in (Secret|ConfigMap) ([\w./-]+)/i.exec(message);
      if (key) return `Add key "${key[1]}" to ${key[2]} ${key[3]} or fix the reference in the pod spec.`;
      return message ? `Fix the referenced ConfigMap, Secret or volume: ${message}` : 'Check that the referenced ConfigMaps, Secrets and volumes exist.';
    }
    case 'oom':
      return `Raise the memory limit (currently ${ctx.memoryLimit ?? 'unset'})${ctx.container ? ` on container ${ctx.container}` : ''} or fix the memory leak.`;
    case 'crash':
      return `Read the container logs; last exit code ${ctx.exitCode ?? 'unknown'}${ctx.lastReason ? ` (${ctx.lastReason})` : ''}.`;
    case 'unschedulable':
      return message ? `The scheduler says: ${message}` : 'Check node capacity, taints/tolerations and affinity rules.';
    default:
      return "Check the pod's events and container logs.";
  }
}

/** The first thing wrong with a pod, with its cause, or null for a healthy / terminating pod. */
export function podCause(pod: V1Pod): PodCause | null {
  if (pod.metadata?.deletionTimestamp) return null; // going away on purpose
  const name = pod.metadata?.name ?? '';
  const namespace = pod.metadata?.namespace ?? '';
  const ref = (container: string | null): PodRef => ({ name, namespace, container });
  const memoryLimitOf = (container: string): string | null => {
    const specs = [...(pod.spec?.containers ?? []), ...(pod.spec?.initContainers ?? [])];
    return specs.find((c) => c.name === container)?.resources?.limits?.memory ?? null;
  };
  const statuses = [
    ...(pod.status?.initContainerStatuses ?? []).map((s) => ({ s, init: true })),
    ...(pod.status?.containerStatuses ?? []).map((s) => ({ s, init: false })),
  ];
  let restarts = 0;
  for (const { s } of statuses) restarts += s.restartCount ?? 0;

  for (const { s, init } of statuses) {
    const w = s.state?.waiting;
    const t = s.state?.terminated;
    const last = s.lastState?.terminated;
    const label = `${init ? 'init container' : 'container'} ${s.name}`;
    if (w?.reason && BROKEN_REASON.test(w.reason)) {
      const cause = classifyCause(w.reason, last?.reason);
      const detail = [label, w.message ?? (last?.reason ? `last exit: ${last.reason}${last.exitCode !== undefined ? ` (${last.exitCode})` : ''}` : null)]
        .filter(Boolean)
        .join(' — ');
      return {
        cause,
        severity: 'critical',
        reason: w.reason,
        detail,
        suggestion: suggestionFor(cause, { container: s.name, namespace, image: s.image, message: w.message, exitCode: last?.exitCode, lastReason: last?.reason, memoryLimit: memoryLimitOf(s.name) }),
        pod: ref(s.name),
        restarts,
        exitCode: last?.exitCode ?? null,
        since: iso(last?.finishedAt ?? pod.status?.startTime),
      };
    }
    if (t && (t.exitCode ?? 0) !== 0 && !init) {
      const cause = classifyCause(t.reason ?? 'Error', t.reason);
      return {
        cause,
        severity: 'critical',
        reason: t.reason ?? `ExitCode ${t.exitCode}`,
        detail: `${label}${t.message ? ` — ${t.message}` : ''}`,
        suggestion: suggestionFor(cause, { container: s.name, namespace, message: t.message, exitCode: t.exitCode, lastReason: t.reason, memoryLimit: memoryLimitOf(s.name) }),
        pod: ref(s.name),
        restarts,
        exitCode: t.exitCode ?? null,
        since: iso(t.finishedAt),
      };
    }
  }
  if (pod.status?.phase === 'Failed') {
    const cause = classifyCause(pod.status.reason);
    return {
      cause,
      severity: 'critical',
      reason: pod.status.reason ?? 'Failed',
      detail: pod.status.message ?? null,
      suggestion: suggestionFor(cause, { container: null, namespace, message: pod.status.message }),
      pod: ref(null),
      restarts,
      exitCode: null,
      since: iso(pod.status.startTime),
    };
  }
  const scheduled = pod.status?.conditions?.find((c) => c.type === 'PodScheduled');
  if (pod.status?.phase === 'Pending' && scheduled && scheduled.status !== 'True' && scheduled.reason) {
    return {
      cause: 'unschedulable',
      severity: 'warning',
      reason: scheduled.reason,
      detail: scheduled.message ?? null,
      suggestion: suggestionFor('unschedulable', { container: null, namespace, message: scheduled.message }),
      pod: ref(null),
      restarts,
      exitCode: null,
      since: iso(scheduled.lastTransitionTime ?? pod.metadata?.creationTimestamp),
    };
  }
  // Ready=False for a long-running pod that is not otherwise broken: probes failing.
  const ready = pod.status?.conditions?.find((c) => c.type === 'Ready');
  if (pod.status?.phase === 'Running' && ready && ready.status !== 'True' && ready.reason === 'ContainersNotReady') {
    return {
      cause: 'unknown',
      severity: 'warning',
      reason: 'NotReady',
      detail: ready.message ?? null,
      suggestion: "The readiness probe is failing: check the probe path/port and the application's health endpoint.",
      pod: ref(null),
      restarts,
      exitCode: null,
      since: iso(ready.lastTransitionTime),
    };
  }
  return null;
}

const SEVERITY_RANK = { critical: 0, warning: 1 } as const;

/** The pod that best explains a workload's trouble: critical first, then most restarts, then most recent. */
export function worstPodCause(causes: readonly PodCause[] | undefined): PodCause | null {
  let worst: PodCause | null = null;
  for (const c of causes ?? []) {
    if (!worst) { worst = c; continue; }
    if (SEVERITY_RANK[c.severity] !== SEVERITY_RANK[worst.severity]) {
      if (SEVERITY_RANK[c.severity] < SEVERITY_RANK[worst.severity]) worst = c;
      continue;
    }
    if (c.restarts !== worst.restarts) {
      if (c.restarts > worst.restarts) worst = c;
      continue;
    }
    const tc = c.since ? new Date(c.since).getTime() : 0;
    const tw = worst.since ? new Date(worst.since).getTime() : 0;
    if (tc > tw) worst = c;
  }
  return worst;
}
