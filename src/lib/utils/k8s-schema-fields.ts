/**
 * Kubernetes YAML schema field definitions.
 * Contains the SchemaField interface and all reusable sub-schemas
 * shared across resource type definitions.
 */

export interface SchemaField {
  /** Human-readable description */
  desc?: string;
  /** Expected value type */
  type: "string" | "number" | "boolean" | "object" | "array" | "any";
  /** Whether the field is required */
  required?: boolean;
  /** Allowed enum values */
  enum?: string[];
  /** Child fields (for objects) */
  children?: Record<string, SchemaField>;
  /** Schema for array items */
  items?: SchemaField;
}

// ---------------------------------------------------------------------------
// Common sub-schemas reused across resource types
// ---------------------------------------------------------------------------

export const labelSelector: Record<string, SchemaField> = {
  matchLabels: { type: "object", desc: "Map of key-value label pairs" },
  matchExpressions: {
    type: "array",
    desc: "List of label selector requirements",
    items: {
      type: "object",
      children: {
        key: { type: "string", required: true, desc: "Label key" },
        operator: { type: "string", required: true, enum: ["In", "NotIn", "Exists", "DoesNotExist"], desc: "Operator" },
        values: { type: "array", desc: "Values for In/NotIn operators", items: { type: "string" } },
      },
    },
  },
};

export const objectMeta: Record<string, SchemaField> = {
  name: { type: "string", required: true, desc: "Resource name" },
  namespace: { type: "string", desc: "Namespace (omit for cluster-scoped)" },
  labels: { type: "object", desc: "Key-value labels for organizing resources" },
  annotations: { type: "object", desc: "Key-value annotations for metadata" },
  generateName: { type: "string", desc: "Prefix for auto-generated name" },
  finalizers: { type: "array", desc: "Finalizers list", items: { type: "string" } },
  ownerReferences: {
    type: "array",
    desc: "Owner references for garbage collection",
    items: {
      type: "object",
      children: {
        apiVersion: { type: "string", required: true },
        kind: { type: "string", required: true },
        name: { type: "string", required: true },
        uid: { type: "string", required: true },
        controller: { type: "boolean" },
        blockOwnerDeletion: { type: "boolean" },
      },
    },
  },
};

export const resourceRequirements: Record<string, SchemaField> = {
  limits: {
    type: "object",
    desc: "Maximum resource limits",
    children: {
      cpu: { type: "string", desc: "CPU limit (e.g. '500m', '1')" },
      memory: { type: "string", desc: "Memory limit (e.g. '128Mi', '1Gi')" },
      "ephemeral-storage": { type: "string", desc: "Ephemeral storage limit" },
    },
  },
  requests: {
    type: "object",
    desc: "Minimum resource requests",
    children: {
      cpu: { type: "string", desc: "CPU request (e.g. '100m', '0.5')" },
      memory: { type: "string", desc: "Memory request (e.g. '64Mi', '256Mi')" },
      "ephemeral-storage": { type: "string", desc: "Ephemeral storage request" },
    },
  },
};

export const envVar: SchemaField = {
  type: "object",
  children: {
    name: { type: "string", required: true, desc: "Environment variable name" },
    value: { type: "string", desc: "Direct value" },
    valueFrom: {
      type: "object",
      desc: "Source for the value",
      children: {
        configMapKeyRef: {
          type: "object",
          children: {
            name: { type: "string", required: true, desc: "ConfigMap name" },
            key: { type: "string", required: true, desc: "Key within the ConfigMap" },
            optional: { type: "boolean" },
          },
        },
        secretKeyRef: {
          type: "object",
          children: {
            name: { type: "string", required: true, desc: "Secret name" },
            key: { type: "string", required: true, desc: "Key within the Secret" },
            optional: { type: "boolean" },
          },
        },
        fieldRef: {
          type: "object",
          children: {
            fieldPath: {
              type: "string",
              enum: ["metadata.name", "metadata.namespace", "metadata.uid", "metadata.labels", "metadata.annotations", "spec.nodeName", "spec.serviceAccountName", "status.hostIP", "status.podIP"],
            },
          },
        },
        resourceFieldRef: {
          type: "object",
          children: {
            containerName: { type: "string" },
            resource: { type: "string", enum: ["limits.cpu", "limits.memory", "requests.cpu", "requests.memory"] },
          },
        },
      },
    },
  },
};

export const probe: Record<string, SchemaField> = {
  httpGet: {
    type: "object",
    desc: "HTTP GET probe",
    children: {
      path: { type: "string", desc: "Path to probe (e.g. /healthz)" },
      port: { type: "any", required: true, desc: "Port number or name" },
      scheme: { type: "string", enum: ["HTTP", "HTTPS"] },
      httpHeaders: { type: "array", items: { type: "object", children: { name: { type: "string" }, value: { type: "string" } } } },
    },
  },
  tcpSocket: {
    type: "object",
    desc: "TCP socket probe",
    children: {
      port: { type: "any", required: true, desc: "Port number or name" },
    },
  },
  exec: {
    type: "object",
    desc: "Exec probe",
    children: {
      command: { type: "array", desc: "Command to execute", items: { type: "string" } },
    },
  },
  grpc: {
    type: "object",
    desc: "gRPC probe",
    children: {
      port: { type: "number", required: true },
      service: { type: "string" },
    },
  },
  initialDelaySeconds: { type: "number", desc: "Seconds before first probe" },
  periodSeconds: { type: "number", desc: "Probe interval in seconds" },
  timeoutSeconds: { type: "number", desc: "Probe timeout in seconds" },
  successThreshold: { type: "number", desc: "Min consecutive successes" },
  failureThreshold: { type: "number", desc: "Min consecutive failures" },
};

export const volumeMount: SchemaField = {
  type: "object",
  children: {
    name: { type: "string", required: true, desc: "Volume name" },
    mountPath: { type: "string", required: true, desc: "Path to mount in container" },
    subPath: { type: "string", desc: "Sub-path within the volume" },
    readOnly: { type: "boolean", desc: "Mount as read-only" },
  },
};

export const containerPort: SchemaField = {
  type: "object",
  children: {
    name: { type: "string", desc: "Port name" },
    containerPort: { type: "number", required: true, desc: "Container port number" },
    protocol: { type: "string", enum: ["TCP", "UDP", "SCTP"], desc: "Protocol" },
    hostPort: { type: "number", desc: "Host port (avoid in production)" },
  },
};

export const securityContext: Record<string, SchemaField> = {
  runAsUser: { type: "number", desc: "UID to run as" },
  runAsGroup: { type: "number", desc: "GID to run as" },
  runAsNonRoot: { type: "boolean", desc: "Must run as non-root" },
  readOnlyRootFilesystem: { type: "boolean", desc: "Read-only root filesystem" },
  allowPrivilegeEscalation: { type: "boolean", desc: "Allow privilege escalation" },
  privileged: { type: "boolean", desc: "Run as privileged" },
  capabilities: {
    type: "object",
    children: {
      add: { type: "array", items: { type: "string" }, desc: "Capabilities to add" },
      drop: { type: "array", items: { type: "string" }, desc: "Capabilities to drop" },
    },
  },
  seccompProfile: {
    type: "object",
    children: {
      type: { type: "string", enum: ["RuntimeDefault", "Unconfined", "Localhost"] },
      localhostProfile: { type: "string" },
    },
  },
};

export const container: Record<string, SchemaField> = {
  name: { type: "string", required: true, desc: "Container name" },
  image: { type: "string", required: true, desc: "Container image (e.g. nginx:1.25)" },
  imagePullPolicy: { type: "string", enum: ["Always", "IfNotPresent", "Never"], desc: "Image pull policy" },
  command: { type: "array", desc: "Entrypoint command", items: { type: "string" } },
  args: { type: "array", desc: "Command arguments", items: { type: "string" } },
  workingDir: { type: "string", desc: "Working directory" },
  ports: { type: "array", desc: "Container ports", items: containerPort },
  env: { type: "array", desc: "Environment variables", items: envVar },
  envFrom: {
    type: "array",
    desc: "Environment from ConfigMap/Secret",
    items: {
      type: "object",
      children: {
        configMapRef: { type: "object", children: { name: { type: "string", required: true }, optional: { type: "boolean" } } },
        secretRef: { type: "object", children: { name: { type: "string", required: true }, optional: { type: "boolean" } } },
        prefix: { type: "string", desc: "Prefix for env var names" },
      },
    },
  },
  resources: { type: "object", desc: "Resource requirements", children: resourceRequirements },
  volumeMounts: { type: "array", desc: "Volume mounts", items: volumeMount },
  livenessProbe: { type: "object", desc: "Liveness probe", children: probe },
  readinessProbe: { type: "object", desc: "Readiness probe", children: probe },
  startupProbe: { type: "object", desc: "Startup probe", children: probe },
  lifecycle: {
    type: "object",
    desc: "Lifecycle hooks",
    children: {
      preStop: { type: "object", children: { exec: { type: "object", children: { command: { type: "array", items: { type: "string" } } } }, httpGet: { type: "object", children: { path: { type: "string" }, port: { type: "any" } } } } },
      postStart: { type: "object", children: { exec: { type: "object", children: { command: { type: "array", items: { type: "string" } } } }, httpGet: { type: "object", children: { path: { type: "string" }, port: { type: "any" } } } } },
    },
  },
  securityContext: { type: "object", desc: "Container security context", children: securityContext },
  stdin: { type: "boolean" },
  tty: { type: "boolean" },
  terminationMessagePath: { type: "string" },
  terminationMessagePolicy: { type: "string", enum: ["File", "FallbackToLogsOnError"] },
};

export const volume: SchemaField = {
  type: "object",
  children: {
    name: { type: "string", required: true, desc: "Volume name" },
    emptyDir: { type: "object", desc: "Empty directory volume", children: { medium: { type: "string", enum: ["", "Memory"] }, sizeLimit: { type: "string" } } },
    hostPath: { type: "object", desc: "Host path volume", children: { path: { type: "string", required: true }, type: { type: "string", enum: ["", "DirectoryOrCreate", "Directory", "FileOrCreate", "File", "Socket", "CharDevice", "BlockDevice"] } } },
    configMap: {
      type: "object",
      desc: "ConfigMap volume",
      children: {
        name: { type: "string", required: true, desc: "ConfigMap name" },
        items: { type: "array", items: { type: "object", children: { key: { type: "string" }, path: { type: "string" } } } },
        defaultMode: { type: "number" },
        optional: { type: "boolean" },
      },
    },
    secret: {
      type: "object",
      desc: "Secret volume",
      children: {
        secretName: { type: "string", required: true, desc: "Secret name" },
        items: { type: "array", items: { type: "object", children: { key: { type: "string" }, path: { type: "string" } } } },
        defaultMode: { type: "number" },
        optional: { type: "boolean" },
      },
    },
    persistentVolumeClaim: {
      type: "object",
      desc: "PVC volume",
      children: {
        claimName: { type: "string", required: true, desc: "PVC name" },
        readOnly: { type: "boolean" },
      },
    },
    projected: {
      type: "object",
      desc: "Projected volume",
      children: {
        sources: { type: "array", items: { type: "object" } },
        defaultMode: { type: "number" },
      },
    },
    downwardAPI: { type: "object", desc: "Downward API volume" },
    nfs: { type: "object", children: { server: { type: "string", required: true }, path: { type: "string", required: true }, readOnly: { type: "boolean" } } },
    csi: { type: "object", children: { driver: { type: "string", required: true }, readOnly: { type: "boolean" }, volumeAttributes: { type: "object" } } },
  },
};

export const podSpec: Record<string, SchemaField> = {
  containers: { type: "array", required: true, desc: "List of containers", items: { type: "object", children: container } },
  initContainers: { type: "array", desc: "Init containers", items: { type: "object", children: container } },
  volumes: { type: "array", desc: "Pod volumes", items: volume },
  restartPolicy: { type: "string", enum: ["Always", "OnFailure", "Never"], desc: "Restart policy" },
  serviceAccountName: { type: "string", desc: "Service account name" },
  serviceAccount: { type: "string", desc: "Deprecated: use serviceAccountName" },
  automountServiceAccountToken: { type: "boolean" },
  nodeName: { type: "string", desc: "Schedule on specific node" },
  nodeSelector: { type: "object", desc: "Node label selector" },
  affinity: {
    type: "object",
    desc: "Scheduling constraints",
    children: {
      nodeAffinity: { type: "object" },
      podAffinity: { type: "object" },
      podAntiAffinity: { type: "object" },
    },
  },
  tolerations: {
    type: "array",
    desc: "Tolerations for taints",
    items: {
      type: "object",
      children: {
        key: { type: "string" },
        operator: { type: "string", enum: ["Equal", "Exists"] },
        value: { type: "string" },
        effect: { type: "string", enum: ["NoSchedule", "PreferNoSchedule", "NoExecute"] },
        tolerationSeconds: { type: "number" },
      },
    },
  },
  topologySpreadConstraints: {
    type: "array",
    items: {
      type: "object",
      children: {
        maxSkew: { type: "number", required: true },
        topologyKey: { type: "string", required: true },
        whenUnsatisfiable: { type: "string", enum: ["DoNotSchedule", "ScheduleAnyway"], required: true },
        labelSelector: { type: "object", children: labelSelector },
      },
    },
  },
  hostNetwork: { type: "boolean" },
  hostPID: { type: "boolean" },
  hostIPC: { type: "boolean" },
  dnsPolicy: { type: "string", enum: ["ClusterFirst", "Default", "ClusterFirstWithHostNet", "None"] },
  dnsConfig: { type: "object", children: { nameservers: { type: "array", items: { type: "string" } }, searches: { type: "array", items: { type: "string" } }, options: { type: "array" } } },
  terminationGracePeriodSeconds: { type: "number", desc: "Grace period in seconds" },
  imagePullSecrets: { type: "array", items: { type: "object", children: { name: { type: "string", required: true } } } },
  securityContext: {
    type: "object",
    desc: "Pod security context",
    children: {
      runAsUser: { type: "number" },
      runAsGroup: { type: "number" },
      runAsNonRoot: { type: "boolean" },
      fsGroup: { type: "number", desc: "File system group ID" },
      fsGroupChangePolicy: { type: "string", enum: ["OnRootMismatch", "Always"] },
      supplementalGroups: { type: "array", items: { type: "number" } },
      seccompProfile: { type: "object", children: { type: { type: "string", enum: ["RuntimeDefault", "Unconfined", "Localhost"] }, localhostProfile: { type: "string" } } },
    },
  },
  priorityClassName: { type: "string", desc: "Priority class name" },
  preemptionPolicy: { type: "string", enum: ["PreemptLowerPriority", "Never"] },
  enableServiceLinks: { type: "boolean" },
  shareProcessNamespace: { type: "boolean" },
  hostname: { type: "string" },
  subdomain: { type: "string" },
};

// ---------------------------------------------------------------------------
// Top-level fields shared by all resource schemas
// ---------------------------------------------------------------------------

export const topLevelFields: Record<string, SchemaField> = {
  apiVersion: { type: "string", required: true, desc: "API version" },
  kind: { type: "string", required: true, desc: "Resource kind" },
  metadata: { type: "object", required: true, desc: "Resource metadata", children: objectMeta },
};

export const deploymentStrategy: Record<string, SchemaField> = {
  type: { type: "string", enum: ["RollingUpdate", "Recreate"], desc: "Deployment strategy type" },
  rollingUpdate: {
    type: "object",
    children: {
      maxSurge: { type: "any", desc: "Max pods over desired (e.g. '25%' or 1)" },
      maxUnavailable: { type: "any", desc: "Max unavailable pods (e.g. '25%' or 0)" },
    },
  },
};
