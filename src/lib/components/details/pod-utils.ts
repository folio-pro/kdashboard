/**
 * Utility functions for PodDetails and its sub-components.
 */

export function parseResourceValue(val: string): { value: string; unit: string } {
  if (val === "-") return { value: "-", unit: "" };
  const match = val.match(/^(\d+\.?\d*)\s*(.*)$/);
  if (match) return { value: match[1], unit: match[2] };
  return { value: val, unit: "" };
}

export function getUsagePercent(request: string, limit: string): number {
  if (request === "-" || limit === "-") return 0;
  const reqVal = parseFloat(request);
  const limVal = parseFloat(limit);
  if (isNaN(reqVal) || isNaN(limVal) || limVal === 0) return 0;
  return Math.min(100, Math.round((reqVal / limVal) * 100));
}

export function getBarColor(percent: number): string {
  if (percent >= 90) return "var(--status-failed)";
  if (percent >= 70) return "var(--status-pending)";
  return "var(--status-running)";
}

export function decodeBase64(val: string): string {
  try { return atob(val); } catch { return val; }
}

export function truncateValue(val: string, max = 500): string {
  return val.length > max ? val.slice(0, max) + "\u2026" : val;
}

/** Container spec type used across pod sub-components. */
export interface SpecContainer {
  name: string;
  image: string;
  ports?: Array<{ containerPort: number; protocol?: string }>;
  resources?: {
    requests?: Record<string, string>;
    limits?: Record<string, string>;
  };
  envFrom?: Array<{
    configMapRef?: { name: string };
    secretRef?: { name: string };
  }>;
  env?: Array<{
    valueFrom?: {
      configMapKeyRef?: { name: string };
      secretKeyRef?: { name: string };
    };
  }>;
}

/** Container status type from the K8s API. */
export interface ContainerStatus {
  name: string;
  image: string;
  ready: boolean;
  restartCount: number;
  state: Record<string, unknown>;
  started?: boolean;
}

/** A port reference derived from spec containers. */
export interface PortInfo {
  containerName: string;
  containerPort: number;
  protocol: string;
}

/** A config/secret reference extracted from the pod spec. */
export interface ConfigRef {
  kind: string;
  name: string;
  keys?: number;
}

/**
 * Extract all ConfigMap and Secret references from volumes and container env specs.
 */
export function extractConfigMapReferences(
  volumes: Array<{
    name: string;
    configMap?: { name: string; items?: Array<{ key: string }> };
    secret?: { secretName: string; items?: Array<{ key: string }> };
  }>,
  specContainers: SpecContainer[],
): ConfigRef[] {
  const refs: ConfigRef[] = [];
  const seen = new Set<string>();

  for (const vol of volumes) {
    if (vol.configMap?.name && !seen.has(`cm:${vol.configMap.name}`)) {
      seen.add(`cm:${vol.configMap.name}`);
      refs.push({ kind: "ConfigMap", name: vol.configMap.name, keys: vol.configMap.items?.length });
    }
    if (vol.secret?.secretName && !seen.has(`sec:${vol.secret.secretName}`)) {
      seen.add(`sec:${vol.secret.secretName}`);
      refs.push({ kind: "Secret", name: vol.secret.secretName, keys: vol.secret.items?.length });
    }
  }

  for (const container of specContainers) {
    for (const envFrom of container.envFrom ?? []) {
      if (envFrom.configMapRef?.name && !seen.has(`cm:${envFrom.configMapRef.name}`)) {
        seen.add(`cm:${envFrom.configMapRef.name}`);
        refs.push({ kind: "ConfigMap", name: envFrom.configMapRef.name });
      }
      if (envFrom.secretRef?.name && !seen.has(`sec:${envFrom.secretRef.name}`)) {
        seen.add(`sec:${envFrom.secretRef.name}`);
        refs.push({ kind: "Secret", name: envFrom.secretRef.name });
      }
    }
    for (const envVar of container.env ?? []) {
      const cmRef = envVar.valueFrom?.configMapKeyRef?.name;
      if (cmRef && !seen.has(`cm:${cmRef}`)) {
        seen.add(`cm:${cmRef}`);
        refs.push({ kind: "ConfigMap", name: cmRef });
      }
      const secRef = envVar.valueFrom?.secretKeyRef?.name;
      if (secRef && !seen.has(`sec:${secRef}`)) {
        seen.add(`sec:${secRef}`);
        refs.push({ kind: "Secret", name: secRef });
      }
    }
  }

  return refs;
}
