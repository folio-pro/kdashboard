// Resource diagnostics — port of src-tauri/src/k8s/diagnostics/* (pod.rs,
// workload.rs, aggregation.rs, types.rs). Backs the `diagnose_resource` command.
//
// Return SHAPES match the Rust serde output exactly (snake_case: resource_uid,
// resource_kind, resource_name, checked_at, …). The Svelte types in
// src/lib/types/cluster.ts depend on exactly these names.

import { getCoreV1Api, getAppsV1Api, getBatchV1Api } from '../../k8s/client';

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
// Wire types (match diagnostics/types.rs)
// ---------------------------------------------------------------------------

export interface DiagnosticIssue {
  severity: 'critical' | 'warning' | 'info';
  category: string;
  title: string;
  detail: string;
  suggestion: string;
}

export interface DiagnosticResult {
  resource_uid: string;
  resource_kind: string;
  resource_name: string;
  health: 'healthy' | 'degraded' | 'unhealthy';
  issues: DiagnosticIssue[];
  checked_at: string;
}

// ---------------------------------------------------------------------------
// pod.rs::diagnose_pod
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
// workload.rs::diagnose_deployment
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
// Minimal event fetch for the diagnose path
//
// Port of the subset of resources::get_resource_events used by aggregation.rs:
// only reason / message / type_ / count are read. Self-contained here so the
// topology module does not depend on the resources group.
// ---------------------------------------------------------------------------

interface MinimalEvent {
  reason?: string;
  message?: string;
  type_?: string;
  count?: number;
}

const RESOURCE_TYPE_TO_KIND: Record<string, string> = {
  pods: 'Pod',
  deployments: 'Deployment',
  services: 'Service',
  statefulsets: 'StatefulSet',
  daemonsets: 'DaemonSet',
  jobs: 'Job',
  cronjobs: 'CronJob',
  replicasets: 'ReplicaSet',
  configmaps: 'ConfigMap',
  secrets: 'Secret',
  ingresses: 'Ingress',
  nodes: 'Node',
  namespaces: 'Namespace',
  hpa: 'HorizontalPodAutoscaler',
  networkpolicies: 'NetworkPolicy',
  persistentvolumes: 'PersistentVolume',
  persistentvolumeclaims: 'PersistentVolumeClaim',
  storageclasses: 'StorageClass',
  roles: 'Role',
  rolebindings: 'RoleBinding',
  clusterroles: 'ClusterRole',
  clusterrolebindings: 'ClusterRoleBinding',
  resourcequotas: 'ResourceQuota',
  limitranges: 'LimitRange',
  poddisruptionbudgets: 'PodDisruptionBudget',
};

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
      // k8s-openapi/serde maps the JSON field "type" to type_ in Rust; on the
      // wire the K8s Event JSON field is "type".
      type_: asString(e['type']),
      count: asNumber(e['count']),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// aggregation.rs::diagnose_resource
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
    default:
      // Rust falls back to reading a Pod for unknown kinds.
      resp = await core.readNamespacedPod({ name, namespace });
      break;
  }
  const obj = asObject(resp);
  if (!obj) {
    throw new Error(`Failed to read ${kindLower}/${name}`);
  }
  return obj;
}

/** Map plural resource_type used for event lookup, mirroring the Rust match. */
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
    default:
      return 'pods';
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

  // Run diagnostics based on kind
  let issues: DiagnosticIssue[];
  switch (kindLower) {
    case 'pod':
      issues = diagnosePod(obj);
      break;
    case 'deployment':
    case 'statefulset':
    case 'daemonset':
      issues = diagnoseDeployment(obj);
      break;
    default:
      issues = [];
      break;
  }

  // Check events for additional signals (errors swallowed, as in Rust's if-let-Ok)
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
  };
}
