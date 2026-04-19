/**
 * Kubernetes resource metadata constants.
 * API version mappings, common annotations, and common labels.
 */

// API version mapping for each kind
export const KIND_API_VERSIONS: Record<string, string[]> = {
  Pod: ["v1"],
  Service: ["v1"],
  ConfigMap: ["v1"],
  Secret: ["v1"],
  Namespace: ["v1"],
  Node: ["v1"],
  Deployment: ["apps/v1"],
  StatefulSet: ["apps/v1"],
  DaemonSet: ["apps/v1"],
  ReplicaSet: ["apps/v1"],
  Job: ["batch/v1"],
  CronJob: ["batch/v1"],
  Ingress: ["networking.k8s.io/v1"],
  HorizontalPodAutoscaler: ["autoscaling/v2", "autoscaling/v1"],
};

// Common annotation keys for autocompletion
export const COMMON_ANNOTATIONS: string[] = [
  "kubectl.kubernetes.io/last-applied-configuration",
  "kubernetes.io/ingress.class",
  "nginx.ingress.kubernetes.io/rewrite-target",
  "nginx.ingress.kubernetes.io/ssl-redirect",
  "nginx.ingress.kubernetes.io/proxy-body-size",
  "nginx.ingress.kubernetes.io/proxy-read-timeout",
  "nginx.ingress.kubernetes.io/cors-allow-origin",
  "prometheus.io/scrape",
  "prometheus.io/port",
  "prometheus.io/path",
];

// Common label keys
export const COMMON_LABELS: string[] = [
  "app",
  "app.kubernetes.io/name",
  "app.kubernetes.io/instance",
  "app.kubernetes.io/version",
  "app.kubernetes.io/component",
  "app.kubernetes.io/part-of",
  "app.kubernetes.io/managed-by",
  "helm.sh/chart",
  "tier",
  "environment",
  "release",
  "version",
];
