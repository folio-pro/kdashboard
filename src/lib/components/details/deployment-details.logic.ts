// Pure derived data for DeploymentDetails: what the pod template runs (one row
// per container, with request/limit and probes), what a pod costs in requests
// and what that is across the replicas, which HPA scales this deployment and
// which Services select its pods. Testable under bun, no Svelte runtime.

import type { Resource } from "$lib/types";
import { formatBytes, formatCpu, parseCpuQuantity, parseMemoryQuantity } from "$lib/stores/metrics.logic";

type Json = Record<string, unknown>;

interface TemplateContainer {
  name?: string;
  image?: string;
  ports?: Array<{ containerPort?: number; protocol?: string }>;
  env?: unknown[];
  envFrom?: Array<{ configMapRef?: { name?: string }; secretRef?: { name?: string } }>;
  resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
  livenessProbe?: unknown;
  readinessProbe?: unknown;
  startupProbe?: unknown;
}

export interface TemplateContainerRow {
  name: string;
  image: string;
  /** "250m / 500m" — request / limit, "—" for an absent side. */
  cpu: string;
  memory: string;
  /** "8080/TCP, 9090/TCP" or "—". */
  ports: string;
  probes: { liveness: boolean; readiness: boolean; startup: boolean };
  envCount: number;
}

export interface RequestTotals {
  /** Sum of CPU requests across the template's containers, in cores. */
  cpuPerPod: number;
  memoryPerPod: number;
  replicas: number;
  cpuTotal: number;
  memoryTotal: number;
  /** "350m · 192Mi" */
  perPodLabel: string;
  /** "1.05 · 576Mi" */
  totalLabel: string;
}

function templateSpec(resource: Resource): Json {
  const template = (resource.spec as Json | undefined)?.template as { spec?: Json } | undefined;
  return template?.spec ?? {};
}

function templateContainers(resource: Resource): TemplateContainer[] {
  const list = templateSpec(resource).containers;
  return Array.isArray(list) ? (list as TemplateContainer[]) : [];
}

/** Pod template labels (what a Service selector must be a subset of). */
export function templateLabels(resource: Resource): Record<string, string> {
  const template = (resource.spec as Json | undefined)?.template as { metadata?: { labels?: Record<string, string> } } | undefined;
  return template?.metadata?.labels ?? {};
}

const reqLim = (c: TemplateContainer, key: "cpu" | "memory"): string => {
  const req = c.resources?.requests?.[key];
  const lim = c.resources?.limits?.[key];
  if (!req && !lim) return "—";
  return `${req ?? "—"} / ${lim ?? "—"}`;
};

export function templateContainerRows(resource: Resource): TemplateContainerRow[] {
  return templateContainers(resource).map((c) => ({
    name: c.name ?? "",
    image: c.image ?? "",
    cpu: reqLim(c, "cpu"),
    memory: reqLim(c, "memory"),
    ports: (c.ports ?? [])
      .filter((p) => p.containerPort)
      .map((p) => `${p.containerPort}/${p.protocol ?? "TCP"}`)
      .join(", ") || "—",
    probes: { liveness: !!c.livenessProbe, readiness: !!c.readinessProbe, startup: !!c.startupProbe },
    envCount: (c.env?.length ?? 0) + (c.envFrom?.length ?? 0),
  }));
}

/** Requests summed over the template's containers, then multiplied by the desired replicas. */
export function requestTotals(resource: Resource): RequestTotals {
  let cpuPerPod = 0;
  let memoryPerPod = 0;
  for (const c of templateContainers(resource)) {
    const req = c.resources?.requests;
    if (req?.cpu) cpuPerPod += parseCpuQuantity(req.cpu);
    if (req?.memory) memoryPerPod += parseMemoryQuantity(req.memory);
  }
  const raw = (resource.spec as Json | undefined)?.replicas;
  const replicas = typeof raw === "number" ? raw : 1;
  const cpuTotal = cpuPerPod * replicas;
  const memoryTotal = memoryPerPod * replicas;
  return {
    cpuPerPod,
    memoryPerPod,
    replicas,
    cpuTotal,
    memoryTotal,
    perPodLabel: `${formatCpu(cpuPerPod)} · ${formatBytes(memoryPerPod)}`,
    totalLabel: `${formatCpu(cpuTotal)} · ${formatBytes(memoryTotal)}`,
  };
}

/** The Deployment's revision annotation as a number, or null. */
export function deploymentRevision(resource: Resource): number | null {
  const raw = resource.metadata?.annotations?.["deployment.kubernetes.io/revision"];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** "RollingUpdate 25% / 25%", "Recreate". */
export function strategyLabel(resource: Resource): string {
  const strategy = ((resource.spec as Json | undefined)?.strategy ?? {}) as { type?: string; rollingUpdate?: { maxSurge?: string | number; maxUnavailable?: string | number } };
  const type = strategy.type ?? "RollingUpdate";
  if (type !== "RollingUpdate") return type;
  const ru = strategy.rollingUpdate ?? {};
  return `RollingUpdate ${ru.maxSurge ?? "25%"} / ${ru.maxUnavailable ?? "25%"}`;
}

/** The HPA whose scaleTargetRef points at this Deployment, if any. */
export function findAutoscalerFor(resource: Resource, autoscalers: Resource[]): Resource | null {
  const name = resource.metadata.name;
  return (
    autoscalers.find((hpa) => {
      const ref = (hpa.spec as Json | undefined)?.scaleTargetRef as { kind?: string; name?: string } | undefined;
      return ref?.kind === "Deployment" && ref.name === name;
    }) ?? null
  );
}

/** Services whose selector is a non-empty subset of the pod template's labels. */
export function servicesSelecting(resource: Resource, services: Resource[]): Resource[] {
  const labels = templateLabels(resource);
  return services.filter((svc) => {
    const selector = (svc.spec as Json | undefined)?.selector as Record<string, string> | undefined;
    if (!selector) return false;
    const entries = Object.entries(selector);
    if (entries.length === 0) return false;
    return entries.every(([k, v]) => labels[k] === v);
  });
}

export interface TemplateReference {
  kind: "ConfigMap" | "Secret" | "ServiceAccount" | "PersistentVolumeClaim";
  name: string;
}

/** ConfigMaps, Secrets, PVCs and the ServiceAccount the template references, deduped in first-seen order. */
export function templateReferences(resource: Resource): TemplateReference[] {
  const out: TemplateReference[] = [];
  const seen = new Set<string>();
  const add = (kind: TemplateReference["kind"], name: string | undefined) => {
    if (!name) return;
    const key = `${kind}/${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, name });
  };
  const spec = templateSpec(resource);
  const volumes = Array.isArray(spec.volumes) ? (spec.volumes as Json[]) : [];
  for (const vol of volumes) {
    add("ConfigMap", (vol.configMap as { name?: string } | undefined)?.name);
    add("Secret", (vol.secret as { secretName?: string } | undefined)?.secretName);
    add("PersistentVolumeClaim", (vol.persistentVolumeClaim as { claimName?: string } | undefined)?.claimName);
    const projected = vol.projected as { sources?: Json[] } | undefined;
    for (const src of projected?.sources ?? []) {
      add("ConfigMap", (src.configMap as { name?: string } | undefined)?.name);
      add("Secret", (src.secret as { name?: string } | undefined)?.name);
    }
  }
  const containers = [
    ...(Array.isArray(spec.initContainers) ? (spec.initContainers as TemplateContainer[]) : []),
    ...templateContainers(resource),
  ];
  for (const c of containers) {
    for (const ef of c.envFrom ?? []) {
      add("ConfigMap", ef.configMapRef?.name);
      add("Secret", ef.secretRef?.name);
    }
    for (const env of (c.env ?? []) as Array<{ valueFrom?: { configMapKeyRef?: { name?: string }; secretKeyRef?: { name?: string } } }>) {
      add("ConfigMap", env.valueFrom?.configMapKeyRef?.name);
      add("Secret", env.valueFrom?.secretKeyRef?.name);
    }
  }
  const sa = spec.serviceAccountName;
  if (typeof sa === "string" && sa && sa !== "default") add("ServiceAccount", sa);
  return out;
}
