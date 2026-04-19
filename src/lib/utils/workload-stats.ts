import type { Resource } from "$lib/types";

export interface WorkloadStat {
  key: string;
  label: string;
  value: number;
  color: string;
  subtitle?: string;
  filterable: boolean;
}

export interface WorkloadStatsResult {
  stats: WorkloadStat[];
  healthSegments: HealthSegment[];
}

export interface HealthSegment {
  key: string;
  value: number;
  color: string;
}

// Shared pod status classification — used by both stat computation and table rendering
export function classifyPodStatus(resource: Resource): "running" | "pending" | "failed" | "succeeded" | "unknown" {
  const phase = (resource.status?.phase as string) ?? "";
  if (phase === "Succeeded") return "succeeded";
  if (phase === "Failed") return "failed";
  if (phase === "Pending") return "pending";
  if (phase === "Running") {
    // Check container statuses for crashlooping/error states
    const cs = resource.status?.containerStatuses as Array<{ state?: Record<string, unknown> }> | undefined;
    if (cs) {
      for (const c of cs) {
        if (c.state?.waiting) {
          const reason = ((c.state.waiting as { reason?: string }).reason ?? "");
          if (/error|crash|backoff/i.test(reason)) return "failed";
        }
        if (c.state?.terminated) {
          const exitCode = (c.state.terminated as { exitCode?: number }).exitCode;
          if (exitCode && exitCode !== 0) return "failed";
        }
      }
    }
    return "running";
  }
  return "unknown";
}

export function getTotalRestarts(resource: Resource): number {
  const cs = resource.status?.containerStatuses as Array<{ restartCount?: number }> | undefined;
  if (!cs) return 0;
  return cs.reduce((sum, c) => sum + (c.restartCount ?? 0), 0);
}

export function isPodNeedingAttention(resource: Resource): boolean {
  const cs = resource.status?.containerStatuses as Array<{ restartCount?: number; state?: Record<string, unknown> }> | undefined;
  if (!cs) return false;
  const totalRestarts = cs.reduce((s, c) => s + (c.restartCount ?? 0), 0);
  const hasWaiting = cs.some((c) => {
    if (!c.state?.waiting) return false;
    const reason = ((c.state.waiting as { reason?: string }).reason ?? "");
    return /error|crash|backoff|oom/i.test(reason);
  });
  return totalRestarts > 10 || hasWaiting;
}

export function computePodStats(items: Resource[]): WorkloadStatsResult {
  let running = 0, pending = 0, failed = 0, succeeded = 0, totalRestarts = 0;

  for (const item of items) {
    const status = classifyPodStatus(item);
    if (status === "running") running++;
    else if (status === "pending") pending++;
    else if (status === "failed") failed++;
    else if (status === "succeeded") succeeded++;
    totalRestarts += getTotalRestarts(item);
  }

  const total = items.length;
  return {
    stats: [
      { key: "total", label: "Total", value: total, color: "var(--accent)", subtitle: "pods", filterable: false },
      { key: "running", label: "Running", value: running, color: "var(--status-running)", subtitle: "healthy", filterable: true },
      { key: "failed", label: "Failing", value: failed, color: "var(--status-failed)", subtitle: "need attention", filterable: true },
      { key: "pending", label: "Pending", value: pending, color: "var(--status-pending)", subtitle: "starting", filterable: true },
      { key: "restarts", label: "Restarts", value: totalRestarts, color: "var(--text-muted)", subtitle: "total", filterable: false },
    ],
    healthSegments: [
      { key: "running", value: running, color: "var(--status-running)" },
      { key: "pending", value: pending, color: "var(--status-pending)" },
      { key: "failed", value: failed, color: "var(--status-failed)" },
    ],
  };
}

export function classifyDeployment(resource: Resource): "healthy" | "degraded" | "failing" | "rollingOut" {
  const replicas = (resource.spec?.replicas as number) ?? 0;
  const available = (resource.status?.availableReplicas as number) ?? 0;
  const updated = (resource.status?.updatedReplicas as number) ?? 0;
  if (replicas > 0 && available === 0) return "failing";
  if (replicas > 0 && updated < replicas) return "rollingOut";
  if (replicas === 0 || available >= replicas) return "healthy";
  return "degraded";
}

export function computeDeploymentStats(items: Resource[]): WorkloadStatsResult {
  let healthy = 0, degraded = 0, failing = 0, rollingOut = 0;

  for (const item of items) {
    const status = classifyDeployment(item);
    if (status === "failing") failing++;
    else if (status === "rollingOut") rollingOut++;
    else if (status === "healthy") healthy++;
    else degraded++;
  }

  const total = items.length;
  return {
    stats: [
      { key: "total", label: "Total", value: total, color: "var(--accent)", subtitle: "deployments", filterable: false },
      { key: "healthy", label: "Healthy", value: healthy, color: "var(--status-running)", subtitle: "available", filterable: true },
      { key: "degraded", label: "Degraded", value: degraded, color: "var(--status-pending)", subtitle: "partial", filterable: true },
      { key: "failing", label: "Failing", value: failing, color: "var(--status-failed)", subtitle: "unavailable", filterable: true },
      { key: "rollingOut", label: "Rolling Out", value: rollingOut, color: "var(--accent)", subtitle: "in progress", filterable: true },
    ],
    healthSegments: [
      { key: "healthy", value: healthy, color: "var(--status-running)" },
      { key: "degraded", value: degraded, color: "var(--status-pending)" },
      { key: "failing", value: failing, color: "var(--status-failed)" },
    ],
  };
}

export function computeServiceStats(items: Resource[]): WorkloadStatsResult {
  let clusterIP = 0, nodePort = 0, loadBalancer = 0, externalName = 0, lbWithIP = 0;

  for (const item of items) {
    const type = (item.spec?.type as string) ?? "ClusterIP";
    if (type === "ClusterIP") clusterIP++;
    else if (type === "NodePort") nodePort++;
    else if (type === "LoadBalancer") {
      loadBalancer++;
      const ingress = (item.status?.loadBalancer as { ingress?: unknown[] })?.ingress;
      if (ingress && ingress.length > 0) lbWithIP++;
    }
    else if (type === "ExternalName") externalName++;
  }

  const total = items.length;
  return {
    stats: [
      { key: "total", label: "Total", value: total, color: "var(--accent)", subtitle: "services", filterable: false },
      { key: "clusterIP", label: "ClusterIP", value: clusterIP, color: "var(--text-secondary)", filterable: true },
      { key: "nodePort", label: "NodePort", value: nodePort, color: "var(--status-pending)", filterable: true },
      { key: "loadBalancer", label: "LoadBalancer", value: loadBalancer, color: "var(--status-running)", subtitle: `${lbWithIP} with IP`, filterable: true },
      { key: "externalName", label: "ExternalName", value: externalName, color: "var(--text-muted)", filterable: true },
    ],
    healthSegments: [
      { key: "clusterIP", value: clusterIP, color: "var(--text-secondary)" },
      { key: "nodePort", value: nodePort, color: "var(--status-pending)" },
      { key: "loadBalancer", value: loadBalancer, color: "var(--status-running)" },
      { key: "externalName", value: externalName, color: "var(--text-muted)" },
    ],
  };
}

export function computeStatefulSetStats(items: Resource[]): WorkloadStatsResult {
  let healthy = 0, degraded = 0, totalReplicas = 0;

  for (const item of items) {
    const replicas = (item.spec?.replicas as number) ?? 0;
    const ready = (item.status?.readyReplicas as number) ?? 0;
    totalReplicas += replicas;

    if (replicas === 0 || ready >= replicas) healthy++;
    else degraded++;
  }

  const total = items.length;
  return {
    stats: [
      { key: "total", label: "Total", value: total, color: "var(--accent)", subtitle: "statefulsets", filterable: false },
      { key: "healthy", label: "Healthy", value: healthy, color: "var(--status-running)", filterable: true },
      { key: "degraded", label: "Degraded", value: degraded, color: "var(--status-failed)", subtitle: "not ready", filterable: true },
      { key: "replicas", label: "Replicas", value: totalReplicas, color: "var(--text-muted)", subtitle: "total", filterable: false },
    ],
    healthSegments: [
      { key: "healthy", value: healthy, color: "var(--status-running)" },
      { key: "degraded", value: degraded, color: "var(--status-failed)" },
    ],
  };
}

export function classifyDaemonSet(resource: Resource): "healthy" | "unavailable" | "misscheduled" {
  const desired = (resource.status?.desiredNumberScheduled as number) ?? 0;
  const available = (resource.status?.numberAvailable as number) ?? 0;
  const mis = (resource.status?.numberMisscheduled as number) ?? 0;
  if (mis > 0) return "misscheduled";
  if (desired > 0 && available < desired) return "unavailable";
  return "healthy";
}

export function computeDaemonSetStats(items: Resource[]): WorkloadStatsResult {
  let healthy = 0, unavailable = 0, misscheduled = 0;

  for (const item of items) {
    const status = classifyDaemonSet(item);
    if (status === "misscheduled") misscheduled++;
    else if (status === "unavailable") unavailable++;
    else healthy++;
  }

  const total = items.length;
  return {
    stats: [
      { key: "total", label: "Total", value: total, color: "var(--accent)", subtitle: "daemonsets", filterable: false },
      { key: "healthy", label: "Healthy", value: healthy, color: "var(--status-running)", filterable: true },
      { key: "unavailable", label: "Unavailable", value: unavailable, color: "var(--status-failed)", filterable: true },
      { key: "misscheduled", label: "Misscheduled", value: misscheduled, color: "var(--status-pending)", subtitle: "scheduling issues", filterable: true },
    ],
    healthSegments: [
      { key: "healthy", value: healthy, color: "var(--status-running)" },
      { key: "unavailable", value: unavailable, color: "var(--status-failed)" },
      { key: "misscheduled", value: misscheduled, color: "var(--status-pending)" },
    ],
  };
}

export function computeJobStats(items: Resource[]): WorkloadStatsResult {
  let succeeded = 0, failed = 0, active = 0;

  for (const item of items) {
    const s = (item.status?.succeeded as number) ?? 0;
    const f = (item.status?.failed as number) ?? 0;
    const a = (item.status?.active as number) ?? 0;
    if (a > 0) active++;
    else if (f > 0 && s === 0) failed++;
    else if (s > 0) succeeded++;
    else failed++; // no status = likely failed
  }

  const total = items.length;
  return {
    stats: [
      { key: "total", label: "Total", value: total, color: "var(--accent)", subtitle: "jobs", filterable: false },
      { key: "succeeded", label: "Succeeded", value: succeeded, color: "var(--status-running)", filterable: true },
      { key: "active", label: "Active", value: active, color: "var(--accent)", subtitle: "running", filterable: true },
      { key: "failed", label: "Failed", value: failed, color: "var(--status-failed)", filterable: true },
    ],
    healthSegments: [
      { key: "succeeded", value: succeeded, color: "var(--status-running)" },
      { key: "active", value: active, color: "var(--accent)" },
      { key: "failed", value: failed, color: "var(--status-failed)" },
    ],
  };
}

export function computeCronJobStats(items: Resource[]): WorkloadStatsResult {
  let activeCount = 0, suspended = 0;

  for (const item of items) {
    const isSuspended = (item.spec?.suspend as boolean) ?? false;
    if (isSuspended) suspended++;
    const activeList = item.status?.active as unknown[] | undefined;
    if (activeList && activeList.length > 0) activeCount++;
  }

  const total = items.length;
  const normal = total - suspended;
  return {
    stats: [
      { key: "total", label: "Total", value: total, color: "var(--accent)", subtitle: "cronjobs", filterable: false },
      { key: "active", label: "Active", value: activeCount, color: "var(--status-running)", subtitle: "running now", filterable: true },
      { key: "suspended", label: "Suspended", value: suspended, color: "var(--status-pending)", filterable: true },
    ],
    healthSegments: [
      { key: "normal", value: normal, color: "var(--status-running)" },
      { key: "suspended", value: suspended, color: "var(--status-pending)" },
    ],
  };
}

export function computeNodeStats(items: Resource[]): WorkloadStatsResult {
  let ready = 0, notReady = 0;

  for (const item of items) {
    const conditions = item.status?.conditions as Array<{ type: string; status: string }> | undefined;
    const isReady = conditions?.some((c) => c.type === "Ready" && c.status === "True") ?? false;
    if (isReady) ready++;
    else notReady++;
  }

  const total = items.length;
  return {
    stats: [
      { key: "total", label: "Total", value: total, color: "var(--accent)", subtitle: "nodes", filterable: false },
      { key: "ready", label: "Ready", value: ready, color: "var(--status-running)", filterable: true },
      { key: "notReady", label: "Not Ready", value: notReady, color: "var(--status-failed)", filterable: true },
    ],
    healthSegments: [
      { key: "ready", value: ready, color: "var(--status-running)" },
      { key: "notReady", value: notReady, color: "var(--status-failed)" },
    ],
  };
}

export function computeIngressStats(items: Resource[]): WorkloadStatsResult {
  let withTLS = 0, withoutTLS = 0;
  const hosts = new Set<string>();

  for (const item of items) {
    const tls = item.spec?.tls as unknown[] | undefined;
    if (tls && tls.length > 0) withTLS++;
    else withoutTLS++;

    const rules = item.spec?.rules as Array<{ host?: string }> | undefined;
    if (rules) {
      for (const r of rules) {
        if (r.host) hosts.add(r.host);
      }
    }
  }

  const total = items.length;
  return {
    stats: [
      { key: "total", label: "Total", value: total, color: "var(--accent)", subtitle: "ingresses", filterable: false },
      { key: "withTLS", label: "With TLS", value: withTLS, color: "var(--status-running)", filterable: true },
      { key: "withoutTLS", label: "Without TLS", value: withoutTLS, color: "var(--status-pending)", subtitle: "no encryption", filterable: true },
      { key: "hosts", label: "Unique Hosts", value: hosts.size, color: "var(--text-muted)", filterable: false },
    ],
    healthSegments: [
      { key: "withTLS", value: withTLS, color: "var(--status-running)" },
      { key: "withoutTLS", value: withoutTLS, color: "var(--status-pending)" },
    ],
  };
}

export function computeReplicaSetStats(items: Resource[]): WorkloadStatsResult {
  let active = 0, orphaned = 0, mismatched = 0;

  for (const item of items) {
    const replicas = (item.spec?.replicas as number) ?? 0;
    const ready = (item.status?.readyReplicas as number) ?? 0;
    const hasOwner = item.metadata.owner_references?.length > 0;

    if (replicas === 0) {
      // Scaled to zero — inactive but normal
    } else if (!hasOwner) {
      orphaned++;
    } else if (ready < replicas) {
      mismatched++;
    } else {
      active++;
    }
  }

  const total = items.length;
  return {
    stats: [
      { key: "total", label: "Total", value: total, color: "var(--accent)", subtitle: "replicasets", filterable: false },
      { key: "active", label: "Active", value: active, color: "var(--status-running)", subtitle: "replicas > 0", filterable: true },
      { key: "orphaned", label: "Orphaned", value: orphaned, color: "var(--status-pending)", subtitle: "no owner", filterable: true },
      { key: "mismatched", label: "Mismatched", value: mismatched, color: "var(--status-failed)", subtitle: "ready < desired", filterable: true },
    ],
    healthSegments: [
      { key: "active", value: active, color: "var(--status-running)" },
      { key: "orphaned", value: orphaned, color: "var(--status-pending)" },
      { key: "mismatched", value: mismatched, color: "var(--status-failed)" },
    ],
  };
}

export function computeConfigMapStats(items: Resource[]): WorkloadStatsResult {
  let totalKeys = 0;

  for (const item of items) {
    const data = item.data ?? {};
    totalKeys += Object.keys(data).length;
  }

  const total = items.length;
  return {
    stats: [
      { key: "total", label: "Total", value: total, color: "var(--accent)", subtitle: "configmaps", filterable: false },
      { key: "keys", label: "Data Keys", value: totalKeys, color: "var(--text-muted)", subtitle: "total", filterable: false },
    ],
    healthSegments: [],
  };
}

export function computeSecretStats(items: Resource[]): WorkloadStatsResult {
  let opaque = 0, tls = 0, dockerConfig = 0, serviceAccount = 0;

  for (const item of items) {
    const type = item.type ?? (item.metadata?.labels?.["kubernetes.io/secret-type"]) ?? "Opaque";
    if (type === "Opaque") opaque++;
    else if (type === "kubernetes.io/tls") tls++;
    else if (type === "kubernetes.io/dockerconfigjson" || type === "kubernetes.io/dockercfg") dockerConfig++;
    else if (type === "kubernetes.io/service-account-token") serviceAccount++;
  }

  const total = items.length;
  return {
    stats: [
      { key: "total", label: "Total", value: total, color: "var(--accent)", subtitle: "secrets", filterable: false },
      { key: "opaque", label: "Opaque", value: opaque, color: "var(--text-secondary)", filterable: true },
      { key: "tls", label: "TLS Certs", value: tls, color: "var(--status-running)", filterable: true },
      { key: "dockerConfig", label: "Docker", value: dockerConfig, color: "var(--accent)", filterable: true },
      { key: "serviceAccount", label: "Svc Account", value: serviceAccount, color: "var(--text-muted)", filterable: true },
    ],
    healthSegments: [
      { key: "opaque", value: opaque, color: "var(--text-secondary)" },
      { key: "tls", value: tls, color: "var(--status-running)" },
      { key: "dockerConfig", value: dockerConfig, color: "var(--accent)" },
      { key: "serviceAccount", value: serviceAccount, color: "var(--text-muted)" },
    ],
  };
}

export function computeNamespaceStats(items: Resource[]): WorkloadStatsResult {
  let active = 0, terminating = 0;

  for (const item of items) {
    const phase = (item.status?.phase as string) ?? "Active";
    if (phase === "Active") active++;
    else if (phase === "Terminating") terminating++;
  }

  const total = items.length;
  return {
    stats: [
      { key: "total", label: "Total", value: total, color: "var(--accent)", subtitle: "namespaces", filterable: false },
      { key: "active", label: "Active", value: active, color: "var(--status-running)", filterable: true },
      { key: "terminating", label: "Terminating", value: terminating, color: "var(--status-failed)", filterable: true },
    ],
    healthSegments: [
      { key: "active", value: active, color: "var(--status-running)" },
      { key: "terminating", value: terminating, color: "var(--status-failed)" },
    ],
  };
}

export function computePVCStats(items: Resource[]): WorkloadStatsResult {
  let bound = 0, pending = 0, lost = 0;

  for (const item of items) {
    const phase = (item.status?.phase as string) ?? "";
    if (phase === "Bound") bound++;
    else if (phase === "Pending") pending++;
    else if (phase === "Lost") lost++;
  }

  const total = items.length;
  return {
    stats: [
      { key: "total", label: "Total", value: total, color: "var(--accent)", subtitle: "PVCs", filterable: false },
      { key: "bound", label: "Bound", value: bound, color: "var(--status-running)", filterable: true },
      { key: "pending", label: "Pending", value: pending, color: "var(--status-pending)", filterable: true },
      { key: "lost", label: "Lost", value: lost, color: "var(--status-failed)", filterable: true },
    ],
    healthSegments: [
      { key: "bound", value: bound, color: "var(--status-running)" },
      { key: "pending", value: pending, color: "var(--status-pending)" },
      { key: "lost", value: lost, color: "var(--status-failed)" },
    ],
  };
}

function computeDefaultStats(items: Resource[], resourceType: string): WorkloadStatsResult {
  return {
    stats: [
      { key: "total", label: "Total", value: items.length, color: "var(--accent)", subtitle: resourceType, filterable: false },
    ],
    healthSegments: [],
  };
}

const computeByType: Record<string, (items: Resource[]) => WorkloadStatsResult> = {
  pods: computePodStats,
  deployments: computeDeploymentStats,
  services: computeServiceStats,
  statefulsets: computeStatefulSetStats,
  daemonsets: computeDaemonSetStats,
  jobs: computeJobStats,
  cronjobs: computeCronJobStats,
  nodes: computeNodeStats,
  ingresses: computeIngressStats,
  replicasets: computeReplicaSetStats,
  configmaps: computeConfigMapStats,
  secrets: computeSecretStats,
  namespaces: computeNamespaceStats,
  persistentvolumeclaims: computePVCStats,
};

export function computeWorkloadStats(resourceType: string, items: Resource[]): WorkloadStatsResult {
  if (!items?.length) {
    const fn = computeByType[resourceType];
    return fn ? fn([]) : computeDefaultStats([], resourceType);
  }
  const fn = computeByType[resourceType];
  return fn ? fn(items) : computeDefaultStats(items, resourceType);
}

// Filter predicate: given a stat key and resource type, does a resource match?
export function matchesStatFilter(resource: Resource, resourceType: string, filterKey: string): boolean {
  switch (resourceType) {
    case "pods":
      return classifyPodStatus(resource) === filterKey;
    case "deployments":
      return classifyDeployment(resource) === filterKey;
    case "services": {
      const type = (resource.spec?.type as string) ?? "ClusterIP";
      if (filterKey === "clusterIP") return type === "ClusterIP";
      if (filterKey === "nodePort") return type === "NodePort";
      if (filterKey === "loadBalancer") return type === "LoadBalancer";
      if (filterKey === "externalName") return type === "ExternalName";
      return false;
    }
    case "statefulsets": {
      const replicas = (resource.spec?.replicas as number) ?? 0;
      const ready = (resource.status?.readyReplicas as number) ?? 0;
      if (filterKey === "healthy") return replicas === 0 || ready >= replicas;
      if (filterKey === "degraded") return replicas > 0 && ready < replicas;
      return false;
    }
    case "daemonsets":
      return classifyDaemonSet(resource) === filterKey;
    case "jobs": {
      const s = (resource.status?.succeeded as number) ?? 0;
      const f = (resource.status?.failed as number) ?? 0;
      const a = (resource.status?.active as number) ?? 0;
      if (filterKey === "succeeded") return s > 0 && a === 0;
      if (filterKey === "active") return a > 0;
      if (filterKey === "failed") return f > 0 && s === 0 && a === 0;
      return false;
    }
    case "cronjobs": {
      const isSuspended = (resource.spec?.suspend as boolean) ?? false;
      const activeList = resource.status?.active as unknown[] | undefined;
      if (filterKey === "active") return (activeList?.length ?? 0) > 0;
      if (filterKey === "suspended") return isSuspended;
      return false;
    }
    case "nodes": {
      const conditions = resource.status?.conditions as Array<{ type: string; status: string }> | undefined;
      const isReady = conditions?.some((c) => c.type === "Ready" && c.status === "True") ?? false;
      if (filterKey === "ready") return isReady;
      if (filterKey === "notReady") return !isReady;
      return false;
    }
    case "ingresses": {
      const tls = resource.spec?.tls as unknown[] | undefined;
      if (filterKey === "withTLS") return (tls?.length ?? 0) > 0;
      if (filterKey === "withoutTLS") return !tls || tls.length === 0;
      return false;
    }
    case "replicasets": {
      const replicas = (resource.spec?.replicas as number) ?? 0;
      const ready = (resource.status?.readyReplicas as number) ?? 0;
      const hasOwner = resource.metadata.owner_references?.length > 0;
      if (filterKey === "active") return replicas > 0 && hasOwner && ready >= replicas;
      if (filterKey === "orphaned") return replicas > 0 && !hasOwner;
      if (filterKey === "mismatched") return replicas > 0 && ready < replicas;
      return false;
    }
    case "secrets": {
      const type = resource.type ?? "Opaque";
      if (filterKey === "opaque") return type === "Opaque";
      if (filterKey === "tls") return type === "kubernetes.io/tls";
      if (filterKey === "dockerConfig") return type === "kubernetes.io/dockerconfigjson" || type === "kubernetes.io/dockercfg";
      if (filterKey === "serviceAccount") return type === "kubernetes.io/service-account-token";
      return false;
    }
    case "namespaces": {
      const phase = (resource.status?.phase as string) ?? "Active";
      if (filterKey === "active") return phase === "Active";
      if (filterKey === "terminating") return phase === "Terminating";
      return false;
    }
    case "persistentvolumeclaims": {
      const phase = (resource.status?.phase as string) ?? "";
      if (filterKey === "bound") return phase === "Bound";
      if (filterKey === "pending") return phase === "Pending";
      if (filterKey === "lost") return phase === "Lost";
      return false;
    }
    default:
      return false;
  }
}
