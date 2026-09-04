// Resource diagnostics — backs the `diagnose_resource` command.
//
// Return shapes are snake_case (resource_uid, resource_kind, resource_name,
// checked_at, …). The Svelte types in src/lib/types/cluster.ts depend on
// exactly these names.
//
// Workloads (Deployment, StatefulSet, DaemonSet, ReplicaSet, Job) are judged
// by the pods they own — listed through the workload's label selector — so
// the diagnosis names the real reason (an image that cannot be pulled, a
// secret that does not exist, an OOM kill…) instead of the controller's
// "no available replicas". The pod judgement is electron/k8s/pod-cause.ts,
// shared with the overview so the two never disagree.

import type { V1Pod } from '@kubernetes/client-node';

import { getCoreV1Api, getAppsV1Api, getBatchV1Api } from '../../k8s/client';
import { RESOURCE_TYPES } from '../../k8s/kinds';
import { podCause, worstPodCause, type PodCause, type PodRef, type ProblemCause } from '../../k8s/pod-cause';

import {
  asObject,
  asArray,
  asString,
  asBool,
  asNumber,
  itemsOf,
  type JsonObject,
} from './shared';

// ---------------------------------------------------------------------------
// Wire types (match src/lib/types/cluster.ts; cause/pod mirror src/lib/types/overview.ts)
// ---------------------------------------------------------------------------

export interface DiagnosticIssue {
  severity: 'critical' | 'warning' | 'info';
  category: string;
  title: string;
  detail: string;
  suggestion: string;
  /** The pod this issue is about, when there is one the UI can open. */
  pod?: PodRef;
}

export interface DiagnosticResult {
  resource_uid: string;
  resource_kind: string;
  resource_name: string;
  health: 'healthy' | 'degraded' | 'unhealthy';
  issues: DiagnosticIssue[];
  checked_at: string;
  /** Machine-readable category the UI keys its actions on. */
  cause: ProblemCause;
  /** The most relevant pod (worst owned pod, last failed job pod, the pod itself), or null. */
  pod: PodRef | null;
}

/** What a kind-specific diagnosis settles on: its issues plus the cause and pod they point at. */
export interface Verdict {
  issues: DiagnosticIssue[];
  cause: ProblemCause;
  pod: PodRef | null;
}

const NO_VERDICT: Verdict = { issues: [], cause: 'unknown', pod: null };

// ---------------------------------------------------------------------------
// diagnosePod
// ---------------------------------------------------------------------------

export function diagnosePod(obj: JsonObject): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  const status = asObject(obj['status']);
  if (!status) return issues;

  const phase = asString(status['phase']) ?? '';

  const containerStatuses = asArray(status['containerStatuses']);
  if (containerStatuses) {
    for (const csRaw of containerStatuses) {
      const cs = asObject(csRaw);
      if (!cs) continue;
      const containerName = asString(cs['name']) ?? 'unknown';
      const restartCount = asNumber(cs['restartCount']) ?? 0;

      const state = asObject(cs['state']);

      // CrashLoopBackOff / ImagePullBackOff / CreateContainerConfigError (waiting)
      const waiting = state ? asObject(state['waiting']) : undefined;
      if (waiting) {
        const reason = asString(waiting['reason']) ?? '';
        const message = asString(waiting['message']) ?? '';

        if (reason === 'CrashLoopBackOff') {
          issues.push({
            severity: 'critical',
            category: 'crash',
            title: `Container '${containerName}' is in CrashLoopBackOff`,
            detail: `Restarts: ${restartCount}. ${message}`,
            suggestion:
              'Check container logs for the crash cause. Common causes: missing env vars, wrong command, config errors.',
          });
        }

        if (reason === 'ImagePullBackOff' || reason === 'ErrImagePull') {
          const image = asString(cs['image']) ?? 'unknown';
          issues.push({
            severity: 'critical',
            category: 'image',
            title: `Container '${containerName}' cannot pull image`,
            detail: `Image: ${image}. ${message}`,
            suggestion:
              'Verify image name/tag exists, check registry credentials (imagePullSecrets), and ensure network access to registry.',
          });
        }

        if (reason === 'CreateContainerConfigError') {
          issues.push({
            severity: 'critical',
            category: 'crash',
            title: `Container '${containerName}' has a config error`,
            detail: message,
            suggestion:
              'Check referenced ConfigMaps, Secrets, and volume mounts exist and are accessible.',
          });
        }
      }

      // OOMKilled — last terminated state
      const lastState = asObject(cs['lastState']);
      const lastTerminated = lastState ? asObject(lastState['terminated']) : undefined;
      if (lastTerminated) {
        const reason = asString(lastTerminated['reason']) ?? '';
        if (reason === 'OOMKilled') {
          issues.push({
            severity: 'critical',
            category: 'oom',
            title: `Container '${containerName}' was OOMKilled`,
            detail: `The container exceeded its memory limit and was killed. Restarts: ${restartCount}`,
            suggestion:
              "Increase memory limits in the pod spec, or investigate the application's memory usage for leaks.",
          });
        }
      }

      // OOMKilled — current terminated state
      const currTerminated = state ? asObject(state['terminated']) : undefined;
      if (currTerminated) {
        const reason = asString(currTerminated['reason']) ?? '';
        if (reason === 'OOMKilled') {
          issues.push({
            severity: 'critical',
            category: 'oom',
            title: `Container '${containerName}' is currently OOMKilled`,
            detail: 'The container ran out of memory.',
            suggestion: "Increase memory limits or optimize the application's memory usage.",
          });
        }
      }

      // High restart count
      if (restartCount > 5) {
        issues.push({
          severity: 'warning',
          category: 'crash',
          title: `Container '${containerName}' has ${restartCount} restarts`,
          detail: 'Frequent restarts indicate instability.',
          suggestion:
            'Check logs across restarts (use --previous flag) to identify the recurring failure pattern.',
        });
      }

      // Not ready (running but not ready)
      const ready = asBool(cs['ready']) ?? false;
      const running = state ? asObject(state['running']) : undefined;
      if (!ready && running !== undefined) {
        issues.push({
          severity: 'warning',
          category: 'readiness',
          title: `Container '${containerName}' is running but not ready`,
          detail: 'The readiness probe is failing.',
          suggestion:
            "Check readiness probe configuration and the application's health endpoint.",
        });
      }
    }
  }

  // Conditions — unschedulable
  const conditions = asArray(status['conditions']);
  if (conditions) {
    for (const condRaw of conditions) {
      const cond = asObject(condRaw);
      if (!cond) continue;
      const ctype = asString(cond['type']) ?? '';
      const cstatus = asString(cond['status']) ?? '';
      const reason = asString(cond['reason']) ?? '';
      const message = asString(cond['message']) ?? '';

      if (ctype === 'PodScheduled' && cstatus === 'False') {
        issues.push({
          severity: 'critical',
          category: 'scheduling',
          title: 'Pod cannot be scheduled',
          detail: `${reason}: ${message}`,
          suggestion:
            'Check node resources (CPU/memory availability), node taints/tolerations, and affinity rules.',
        });
      }
    }
  }

  // Pending phase (only if no other issues)
  if (phase === 'Pending' && issues.length === 0) {
    issues.push({
      severity: 'warning',
      category: 'scheduling',
      title: 'Pod is in Pending state',
      detail: 'The pod has not been scheduled yet.',
      suggestion:
        'Check events for scheduling details, verify resource availability and node capacity.',
    });
  }

  // Missing resource limits
  const spec = asObject(obj['spec']);
  const containers = spec ? asArray(spec['containers']) : undefined;
  if (containers) {
    for (const containerRaw of containers) {
      const container = asObject(containerRaw);
      if (!container) continue;
      const name = asString(container['name']) ?? 'unknown';
      const resources = asObject(container['resources']);
      const limits = resources ? asObject(resources['limits']) : undefined;
      const hasLimits = limits !== undefined && Object.keys(limits).length > 0;

      if (!hasLimits) {
        issues.push({
          severity: 'info',
          category: 'resources',
          title: `Container '${name}' has no resource limits`,
          detail: 'Without resource limits, the container can consume unbounded resources.',
          suggestion: 'Set memory and CPU limits to prevent resource contention and OOM kills.',
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// diagnoseDeployment
// ---------------------------------------------------------------------------

export function diagnoseDeployment(obj: JsonObject): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];
  const status = asObject(obj['status']);
  if (!status) return issues;

  const conditions = asArray(status['conditions']);
  if (conditions) {
    for (const condRaw of conditions) {
      const cond = asObject(condRaw);
      if (!cond) continue;
      const ctype = asString(cond['type']) ?? '';
      const cstatus = asString(cond['status']) ?? '';
      const reason = asString(cond['reason']) ?? '';
      const message = asString(cond['message']) ?? '';

      if (ctype === 'Progressing' && cstatus === 'False' && reason === 'ProgressDeadlineExceeded') {
        issues.push({
          severity: 'critical',
          category: 'crash',
          title: 'Deployment progress deadline exceeded',
          detail: message,
          suggestion:
            'The rollout is stuck. Check pod events and logs for the failing pods. Consider rolling back.',
        });
      }

      if (ctype === 'Available' && cstatus === 'False') {
        issues.push({
          severity: 'critical',
          category: 'readiness',
          title: 'Deployment has no available replicas',
          detail: message,
          suggestion:
            'Check the pods managed by this deployment for crash loops or scheduling issues.',
        });
      }
    }
  }

  // Replica mismatch
  const spec = asObject(obj['spec']);
  const desired = (spec ? asNumber(spec['replicas']) : undefined) ?? 0;
  const ready = asNumber(status['readyReplicas']) ?? 0;
  if (desired > 0 && ready < desired) {
    issues.push({
      severity: 'warning',
      category: 'readiness',
      title: `Only ${ready}/${desired} replicas ready`,
      detail: 'Not all desired replicas are ready.',
      suggestion: 'Check individual pods for issues. A rollout may be in progress.',
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Owned pods: the real reason behind a broken workload
// ---------------------------------------------------------------------------

const CATEGORY_FOR_CAUSE: Record<ProblemCause, string> = {
  'image-pull': 'image',
  config: 'config',
  crash: 'crash',
  oom: 'oom',
  unschedulable: 'scheduling',
  'progress-deadline': 'rollout',
  'job-failed': 'job',
  'pvc-pending': 'storage',
  'no-endpoints': 'network',
  'lb-pending': 'network',
  unknown: 'readiness',
};

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 } as const;

/**
 * One issue per distinct (cause, reason) among the owned pods, worded from
 * the worst pod of each group, so three CrashLoopBackOff replicas make one
 * line and a fourth ImagePullBackOff pod makes another.
 */
export function diagnoseOwnedPods(pods: readonly V1Pod[]): Verdict {
  const causes: PodCause[] = [];
  for (const p of pods) {
    const c = podCause(p);
    if (c) causes.push(c);
  }
  const groups = new Map<string, PodCause[]>();
  for (const c of causes) {
    const key = `${c.cause}|${c.reason}`;
    const list = groups.get(key) ?? [];
    list.push(c);
    groups.set(key, list);
  }
  const issues: DiagnosticIssue[] = [];
  for (const group of groups.values()) {
    const worst = worstPodCause(group);
    if (!worst) continue;
    const n = group.length;
    issues.push({
      severity: worst.severity,
      category: CATEGORY_FOR_CAUSE[worst.cause],
      title: n === 1 ? `Pod ${worst.pod.name}: ${worst.reason}` : `${n} pods in ${worst.reason}`,
      detail: [worst.detail, worst.restarts ? `${worst.restarts} restarts` : null, n > 1 ? `worst: ${worst.pod.name}` : null].filter(Boolean).join(' · ') || worst.reason,
      suggestion: worst.suggestion,
      pod: worst.pod,
    });
  }
  issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const overall = worstPodCause(causes);
  return { issues, cause: overall?.cause ?? 'unknown', pod: overall?.pod ?? null };
}

/** A workload's verdict: its owned pods' issues first, then its own conditions minus the generic line those pods already explain. */
export function diagnoseWorkload(obj: JsonObject, pods: readonly V1Pod[]): Verdict {
  const fromPods = diagnoseOwnedPods(pods);
  const own = diagnoseDeployment(obj).filter((i) => fromPods.issues.length === 0 || i.title !== 'Deployment has no available replicas');
  const deadline = own.some((i) => i.title === 'Deployment progress deadline exceeded');
  return {
    issues: [...fromPods.issues, ...own],
    cause: fromPods.pod ? fromPods.cause : deadline ? 'progress-deadline' : 'unknown',
    pod: fromPods.pod,
  };
}

/** A Job's verdict: how many pods failed, how the last one died, and which pod to open. */
export function diagnoseJob(obj: JsonObject, pods: readonly V1Pod[]): Verdict {
  const status = asObject(obj['status']) ?? {};
  const spec = asObject(obj['spec']) ?? {};
  const conds = (asArray(status['conditions']) ?? []).map(asObject);
  const failedCond = conds.find((c) => c && asString(c['type']) === 'Failed' && asString(c['status']) === 'True');
  const complete = conds.some((c) => c && asString(c['type']) === 'Complete' && asString(c['status']) === 'True');
  const failed = asNumber(status['failed']) ?? 0;
  if (!failedCond && failed === 0) return NO_VERDICT;

  const causes: PodCause[] = [];
  for (const p of pods) {
    const c = podCause(p);
    if (c) causes.push(c);
  }
  const worst = worstPodCause(causes);
  const backoff = asNumber(spec['backoffLimit']);
  const failedText = `${failed} failed pod${failed === 1 ? '' : 's'}${backoff !== undefined ? ` (backoffLimit ${backoff})` : ''}`;
  const lastPod = worst ? `last pod ${worst.pod.name}: ${worst.reason}${worst.detail ? ` — ${worst.detail}` : ''}` : null;
  const exit = worst ? `${worst.exitCode !== null ? `exit code ${worst.exitCode}` : worst.reason}${worst.exitCode !== null && worst.reason !== `ExitCode ${worst.exitCode}` ? ` (${worst.reason})` : ''}` : null;
  const issue: DiagnosticIssue = {
    severity: failedCond && !complete ? 'critical' : 'warning',
    category: 'job',
    title: failedCond ? `Job failed: ${asString(failedCond['reason']) ?? 'Failed'}` : failedText,
    detail: [failedCond ? asString(failedCond['message']) : null, failedText, lastPod].filter(Boolean).join(' · '),
    suggestion: worst
      ? `Read the logs of pod ${worst.pod.name}${worst.pod.container ? ` (container ${worst.pod.container})` : ''}; it ended with ${exit}. A failed Job does not retry until it is recreated.`
      : 'The failed pods are gone; read the logs of the next attempt. A failed Job does not retry until it is recreated.',
    pod: worst?.pod,
  };
  return { issues: [issue], cause: 'job-failed', pod: worst?.pod ?? null };
}

/** A Pending PVC: what the provisioner last said and what to do about it. */
export function diagnosePvc(obj: JsonObject, events: readonly MinimalEvent[]): Verdict {
  const status = asObject(obj['status']) ?? {};
  const spec = asObject(obj['spec']) ?? {};
  if (asString(status['phase']) !== 'Pending') return NO_VERDICT;
  const sc = asString(spec['storageClassName']);
  const provisioning = events.find((e) => e.reason === 'ProvisioningFailed');
  const waiting = events.find((e) => e.reason === 'WaitForFirstConsumer');
  const message = provisioning?.message ?? '';
  const missingClass = /storageclass\.storage\.k8s\.io "([^"]+)" not found/i.exec(message) ?? /storage ?class "([^"]+)" not found/i.exec(message);
  const issue: DiagnosticIssue = {
    severity: provisioning ? 'critical' : 'warning',
    category: 'storage',
    title: provisioning ? 'Volume provisioning failed' : 'Waiting for a volume',
    detail: provisioning?.message ?? waiting?.message ?? (sc ? `storage class "${sc}" has not provided a volume yet` : 'no storage class set and no PersistentVolume matches the claim'),
    suggestion: missingClass
      ? `Create storage class "${missingClass[1]}" or point spec.storageClassName at one that exists (kubectl get storageclass).`
      : provisioning
        ? 'Check the CSI driver / provisioner logs and the storage class parameters.'
        : waiting
          ? 'The volume is provisioned when a pod first mounts this claim; schedule the consumer.'
          : sc
            ? `Check that a provisioner serves storage class "${sc}" and has capacity.`
            : 'Set spec.storageClassName or create a PersistentVolume that satisfies the claim.',
  };
  return { issues: [issue], cause: 'pvc-pending', pod: null };
}

/** A Service with nothing behind it, or a LoadBalancer without an address. `endpoints` is null when it could not be read. */
export function diagnoseService(obj: JsonObject, endpoints: JsonObject | null): Verdict {
  const spec = asObject(obj['spec']) ?? {};
  const status = asObject(obj['status']) ?? {};
  const type = asString(spec['type']) ?? 'ClusterIP';
  const selector = asObject(spec['selector']) ?? {};
  const selectorText = Object.entries(selector).map(([k, v]) => `${k}=${String(v)}`).join(',');
  const issues: DiagnosticIssue[] = [];
  let cause: ProblemCause = 'unknown';

  if (type !== 'ExternalName' && selectorText !== '' && endpoints !== null) {
    let ready = 0;
    let notReady = 0;
    for (const subsetRaw of asArray(endpoints['subsets']) ?? []) {
      const subset = asObject(subsetRaw);
      ready += asArray(subset?.['addresses'])?.length ?? 0;
      notReady += asArray(subset?.['notReadyAddresses'])?.length ?? 0;
    }
    if (ready === 0) {
      cause = 'no-endpoints';
      issues.push({
        severity: 'warning',
        category: 'network',
        title: 'No ready endpoints',
        detail: notReady > 0 ? `${notReady} pod${notReady === 1 ? '' : 's'} match${notReady === 1 ? 'es' : ''} selector ${selectorText} but ${notReady === 1 ? 'is' : 'are'} not ready` : `no ready pod carries labels ${selectorText}`,
        suggestion: notReady > 0
          ? 'Fix the readiness of the matching pods; traffic to this Service is dropped until one is ready.'
          : 'Check the selector against the pod template labels of the workload this Service should front, and that the workload has running pods.',
      });
    }
  }

  const loadBalancer = asObject(status['loadBalancer']);
  const hasAddress = (asArray(loadBalancer?.['ingress']) ?? []).some((i) => {
    const o = asObject(i);
    return !!(o && (asString(o['ip']) || asString(o['hostname'])));
  });
  if (type === 'LoadBalancer' && !hasAddress) {
    if (cause === 'unknown') cause = 'lb-pending';
    issues.push({
      severity: 'warning',
      category: 'network',
      title: 'LoadBalancer has no external address',
      detail: 'status.loadBalancer.ingress is empty — no cloud or bare-metal load-balancer controller has claimed this Service.',
      suggestion: 'Check the cloud controller manager / load-balancer controller (on Kind or bare metal install MetalLB, or use a NodePort).',
    });
  }
  return { issues, cause, pod: null };
}

// ---------------------------------------------------------------------------
// Minimal event fetch for the diagnose path
//
// Only reason / message / type_ / count are read. Self-contained here so the
// topology module does not depend on the resources group.
// ---------------------------------------------------------------------------

interface MinimalEvent {
  reason?: string;
  message?: string;
  type_?: string;
  count?: number;
}

/** resource_type -> involvedObject.kind, straight off the shared registry. */
const RESOURCE_TYPE_TO_KIND: Record<string, string> = Object.fromEntries(
  Object.values(RESOURCE_TYPES).map((e) => [e.type, e.kind]),
);

async function getResourceEvents(
  resourceType: string,
  name: string,
  namespace: string,
): Promise<MinimalEvent[]> {
  const kind = RESOURCE_TYPE_TO_KIND[resourceType] ?? resourceType;
  const fieldSelector = `involvedObject.name=${name},involvedObject.kind=${kind}`;
  const core = getCoreV1Api();

  const resp = namespace
    ? await core.listNamespacedEvent({ namespace, fieldSelector })
    : await core.listEventForAllNamespaces({ fieldSelector });

  const items = itemsOf(resp);
  const out: MinimalEvent[] = [];
  for (const itemRaw of items) {
    const e = asObject(itemRaw);
    if (!e) continue;
    out.push({
      reason: asString(e['reason']),
      message: asString(e['message']),
      // `type` is a reserved-ish key locally, so it is read into type_; the
      // K8s Event JSON field itself is "type".
      type_: asString(e['type']),
      count: asNumber(e['count']),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// diagnoseResource
// ---------------------------------------------------------------------------

/** Read a single namespaced resource as plain JSON, mapping kind -> reader. */
async function readResource(
  kindLower: string,
  name: string,
  namespace: string,
): Promise<JsonObject> {
  const core = getCoreV1Api();
  const apps = getAppsV1Api();
  const batch = getBatchV1Api();

  let resp: unknown;
  switch (kindLower) {
    case 'pod':
      resp = await core.readNamespacedPod({ name, namespace });
      break;
    case 'deployment':
      resp = await apps.readNamespacedDeployment({ name, namespace });
      break;
    case 'statefulset':
      resp = await apps.readNamespacedStatefulSet({ name, namespace });
      break;
    case 'daemonset':
      resp = await apps.readNamespacedDaemonSet({ name, namespace });
      break;
    case 'job':
      resp = await batch.readNamespacedJob({ name, namespace });
      break;
    case 'replicaset':
      resp = await apps.readNamespacedReplicaSet({ name, namespace });
      break;
    case 'persistentvolumeclaim':
      resp = await core.readNamespacedPersistentVolumeClaim({ name, namespace });
      break;
    case 'service':
      resp = await core.readNamespacedService({ name, namespace });
      break;
    default:
      // Unknown kinds fall back to reading a Pod.
      resp = await core.readNamespacedPod({ name, namespace });
      break;
  }
  const obj = asObject(resp);
  if (!obj) {
    throw new Error(`Failed to read ${kindLower}/${name}`);
  }
  return obj;
}

/** Map a singular kind to the plural resource_type used for event lookup. */
function resourceTypeForKind(kindLower: string): string {
  switch (kindLower) {
    case 'pod':
      return 'pods';
    case 'deployment':
      return 'deployments';
    case 'statefulset':
      return 'statefulsets';
    case 'daemonset':
      return 'daemonsets';
    case 'job':
      return 'jobs';
    case 'replicaset':
      return 'replicasets';
    case 'persistentvolumeclaim':
      return 'persistentvolumeclaims';
    case 'service':
      return 'services';
    default:
      return 'pods';
  }
}

const OWNS_PODS = new Set(['deployment', 'statefulset', 'daemonset', 'replicaset', 'job']);

/** "app=web,tier=api" from spec.selector.matchLabels, or null when the object has no label selector. */
export function labelSelectorOf(obj: JsonObject): string | null {
  const spec = asObject(obj['spec']);
  const selector = spec ? asObject(spec['selector']) : undefined;
  const matchLabels = selector ? asObject(selector['matchLabels']) : undefined;
  if (!matchLabels) return null;
  const pairs = Object.entries(matchLabels).map(([k, v]) => `${k}=${String(v)}`);
  return pairs.length > 0 ? pairs.join(',') : null;
}

/** The pods a workload's selector matches; empty when it has no selector or the list fails (best-effort). */
async function listOwnedPods(obj: JsonObject, namespace: string): Promise<V1Pod[]> {
  const labelSelector = labelSelectorOf(obj);
  if (!labelSelector) return [];
  try {
    const resp = await getCoreV1Api().listNamespacedPod({ namespace, labelSelector });
    return (resp.items ?? []) as V1Pod[];
  } catch {
    return [];
  }
}

/**
 * A Pending pod's PodScheduled condition usually carries the scheduler's
 * message; when it does not, the FailedScheduling event does. Best-effort.
 */
async function fillSchedulerMessages(verdict: Verdict, namespace: string): Promise<void> {
  const blank = verdict.issues.filter((i) => i.category === 'scheduling' && i.pod && !i.detail.includes('node'));
  if (blank.length === 0) return;
  try {
    const resp = await getCoreV1Api().listNamespacedEvent({ namespace, fieldSelector: 'reason=FailedScheduling,involvedObject.kind=Pod' });
    for (const issue of blank) {
      const e = itemsOf(resp)
        .map(asObject)
        .find((ev) => ev && asString(asObject(ev['involvedObject'])?.['name']) === issue.pod?.name && asString(ev['message']));
      const message = e ? asString(e['message']) : undefined;
      if (!message) continue;
      issue.detail = `${issue.pod!.name} — ${message}`;
      issue.suggestion = `The scheduler says: ${message}`;
    }
  } catch {
    // events are best-effort
  }
}

async function readEndpoints(name: string, namespace: string): Promise<JsonObject | null> {
  try {
    return asObject(await getCoreV1Api().readNamespacedEndpoints({ name, namespace })) ?? null;
  } catch (err) {
    // A selector Service always has an Endpoints object; a 404 means "nothing behind it".
    const status = (err as { code?: number; statusCode?: number } | null)?.code ?? (err as { statusCode?: number } | null)?.statusCode;
    return status === 404 ? { subsets: [] } : null;
  }
}

export async function diagnoseResource(
  kind: string,
  name: string,
  namespace: string,
): Promise<DiagnosticResult> {
  const now = new Date().toISOString();
  const kindLower = kind.toLowerCase();

  const obj = await readResource(kindLower, name, namespace);

  const meta = asObject(obj['metadata']);
  const uid = (meta ? asString(meta['uid']) : undefined) ?? '';
  const ownedPods = OWNS_PODS.has(kindLower) ? await listOwnedPods(obj, namespace) : [];

  // Run diagnostics based on kind
  let verdict: Verdict;
  switch (kindLower) {
    case 'pod': {
      const own = podCause(obj as unknown as V1Pod);
      verdict = { issues: diagnosePod(obj), cause: own?.cause ?? 'unknown', pod: own?.pod ?? { name, namespace, container: null } };
      break;
    }
    case 'deployment':
    case 'statefulset':
    case 'daemonset':
    case 'replicaset':
      verdict = diagnoseWorkload(obj, ownedPods);
      await fillSchedulerMessages(verdict, namespace);
      break;
    case 'job':
      verdict = diagnoseJob(obj, ownedPods);
      break;
    case 'persistentvolumeclaim': {
      let events: MinimalEvent[] = [];
      try {
        events = await getResourceEvents('persistentvolumeclaims', name, namespace);
      } catch {
        // best-effort
      }
      verdict = diagnosePvc(obj, events);
      break;
    }
    case 'service':
      verdict = diagnoseService(obj, await readEndpoints(name, namespace));
      break;
    default:
      verdict = NO_VERDICT;
      break;
  }
  const issues = [...verdict.issues];

  // Check events for additional signals; a failure here is not fatal.
  try {
    const resourceType = resourceTypeForKind(kindLower);
    const events = await getResourceEvents(resourceType, name, namespace);
    for (const event of events) {
      if (event.type_ === 'Warning') {
        const reason = event.reason ?? '';
        const message = event.message ?? '';
        const count = event.count ?? 1;

        if (count >= 3) {
          const alreadyCovered = issues.some(
            (i) => (reason !== '' && i.title.includes(reason)) || (reason !== '' && i.detail.includes(reason)),
          );
          if (!alreadyCovered) {
            issues.push({
              severity: 'warning',
              category: 'crash',
              title: `Repeated warning event: ${reason}`,
              detail: `${message}. Occurred ${count} times.`,
              suggestion: 'Investigate the event details and related logs.',
            });
          }
        }
      }
    }
  } catch {
    // ignore — events are best-effort
  }

  const health: DiagnosticResult['health'] = issues.some((i) => i.severity === 'critical')
    ? 'unhealthy'
    : issues.some((i) => i.severity === 'warning')
      ? 'degraded'
      : 'healthy';

  return {
    resource_uid: uid,
    resource_kind: kind,
    resource_name: name,
    health,
    issues,
    checked_at: now,
    cause: verdict.cause,
    pod: verdict.pod,
  };
}
