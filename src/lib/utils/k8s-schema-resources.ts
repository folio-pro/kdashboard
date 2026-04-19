/**
 * Kubernetes resource type schema definitions.
 * Contains the K8S_SCHEMAS object mapping each resource kind to its field schema.
 */

import type { SchemaField } from "./k8s-schema-fields.js";
import {
  topLevelFields,
  objectMeta,
  labelSelector,
  podSpec,
  deploymentStrategy,
} from "./k8s-schema-fields.js";

export const K8S_SCHEMAS: Record<string, Record<string, SchemaField>> = {
  Pod: {
    ...topLevelFields,
    spec: { type: "object", required: true, desc: "Pod specification", children: podSpec },
  },

  Deployment: {
    ...topLevelFields,
    spec: {
      type: "object",
      required: true,
      desc: "Deployment specification",
      children: {
        replicas: { type: "number", desc: "Desired pod replicas" },
        selector: { type: "object", required: true, desc: "Label selector", children: labelSelector },
        template: {
          type: "object",
          required: true,
          desc: "Pod template",
          children: {
            metadata: { type: "object", children: objectMeta },
            spec: { type: "object", required: true, children: podSpec },
          },
        },
        strategy: { type: "object", desc: "Deployment strategy", children: deploymentStrategy },
        minReadySeconds: { type: "number" },
        revisionHistoryLimit: { type: "number", desc: "Number of old ReplicaSets to keep" },
        progressDeadlineSeconds: { type: "number" },
        paused: { type: "boolean" },
      },
    },
  },

  StatefulSet: {
    ...topLevelFields,
    spec: {
      type: "object",
      required: true,
      children: {
        replicas: { type: "number" },
        selector: { type: "object", required: true, children: labelSelector },
        template: { type: "object", required: true, children: { metadata: { type: "object", children: objectMeta }, spec: { type: "object", required: true, children: podSpec } } },
        serviceName: { type: "string", required: true, desc: "Governing headless service" },
        podManagementPolicy: { type: "string", enum: ["OrderedReady", "Parallel"] },
        updateStrategy: { type: "object", children: { type: { type: "string", enum: ["RollingUpdate", "OnDelete"] }, rollingUpdate: { type: "object", children: { partition: { type: "number" } } } } },
        revisionHistoryLimit: { type: "number" },
        volumeClaimTemplates: { type: "array", desc: "PVC templates" },
        persistentVolumeClaimRetentionPolicy: { type: "object", children: { whenDeleted: { type: "string", enum: ["Retain", "Delete"] }, whenScaled: { type: "string", enum: ["Retain", "Delete"] } } },
      },
    },
  },

  DaemonSet: {
    ...topLevelFields,
    spec: {
      type: "object",
      required: true,
      children: {
        selector: { type: "object", required: true, children: labelSelector },
        template: { type: "object", required: true, children: { metadata: { type: "object", children: objectMeta }, spec: { type: "object", required: true, children: podSpec } } },
        updateStrategy: { type: "object", children: { type: { type: "string", enum: ["RollingUpdate", "OnDelete"] }, rollingUpdate: { type: "object", children: { maxUnavailable: { type: "any" }, maxSurge: { type: "any" } } } } },
        minReadySeconds: { type: "number" },
        revisionHistoryLimit: { type: "number" },
      },
    },
  },

  Service: {
    ...topLevelFields,
    spec: {
      type: "object",
      required: true,
      desc: "Service specification",
      children: {
        type: { type: "string", enum: ["ClusterIP", "NodePort", "LoadBalancer", "ExternalName"], desc: "Service type" },
        selector: { type: "object", desc: "Pod selector labels" },
        ports: {
          type: "array",
          desc: "Service ports",
          items: {
            type: "object",
            children: {
              name: { type: "string", desc: "Port name" },
              port: { type: "number", required: true, desc: "Service port" },
              targetPort: { type: "any", desc: "Target container port" },
              protocol: { type: "string", enum: ["TCP", "UDP", "SCTP"] },
              nodePort: { type: "number", desc: "Node port (NodePort/LoadBalancer)" },
            },
          },
        },
        clusterIP: { type: "string", desc: "Cluster IP (or 'None' for headless)" },
        externalIPs: { type: "array", items: { type: "string" } },
        externalName: { type: "string", desc: "External DNS name (ExternalName type)" },
        externalTrafficPolicy: { type: "string", enum: ["Cluster", "Local"] },
        internalTrafficPolicy: { type: "string", enum: ["Cluster", "Local"] },
        sessionAffinity: { type: "string", enum: ["None", "ClientIP"] },
        loadBalancerIP: { type: "string" },
        loadBalancerSourceRanges: { type: "array", items: { type: "string" } },
        healthCheckNodePort: { type: "number" },
        publishNotReadyAddresses: { type: "boolean" },
        ipFamilyPolicy: { type: "string", enum: ["SingleStack", "PreferDualStack", "RequireDualStack"] },
      },
    },
  },

  Ingress: {
    ...topLevelFields,
    spec: {
      type: "object",
      required: true,
      children: {
        ingressClassName: { type: "string", desc: "IngressClass name" },
        defaultBackend: {
          type: "object",
          children: {
            service: { type: "object", children: { name: { type: "string", required: true }, port: { type: "object", children: { name: { type: "string" }, number: { type: "number" } } } } },
          },
        },
        tls: {
          type: "array",
          desc: "TLS configuration",
          items: {
            type: "object",
            children: {
              hosts: { type: "array", items: { type: "string" } },
              secretName: { type: "string", desc: "Secret with TLS cert/key" },
            },
          },
        },
        rules: {
          type: "array",
          desc: "Ingress rules",
          items: {
            type: "object",
            children: {
              host: { type: "string", desc: "Hostname" },
              http: {
                type: "object",
                children: {
                  paths: {
                    type: "array",
                    required: true,
                    items: {
                      type: "object",
                      children: {
                        path: { type: "string", desc: "URL path" },
                        pathType: { type: "string", required: true, enum: ["Prefix", "Exact", "ImplementationSpecific"] },
                        backend: {
                          type: "object",
                          required: true,
                          children: {
                            service: { type: "object", children: { name: { type: "string", required: true }, port: { type: "object", children: { name: { type: "string" }, number: { type: "number" } } } } },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },

  ConfigMap: {
    ...topLevelFields,
    data: { type: "object", desc: "Key-value string data" },
    binaryData: { type: "object", desc: "Key-value binary data (base64)" },
    immutable: { type: "boolean", desc: "If true, prevents updates" },
  },

  Secret: {
    ...topLevelFields,
    type: { type: "string", enum: ["Opaque", "kubernetes.io/tls", "kubernetes.io/dockerconfigjson", "kubernetes.io/service-account-token", "kubernetes.io/basic-auth", "kubernetes.io/ssh-auth"], desc: "Secret type" },
    data: { type: "object", desc: "Base64-encoded data" },
    stringData: { type: "object", desc: "Plain-text data (auto base64-encoded)" },
    immutable: { type: "boolean" },
  },

  Job: {
    ...topLevelFields,
    spec: {
      type: "object",
      required: true,
      children: {
        template: { type: "object", required: true, children: { metadata: { type: "object", children: objectMeta }, spec: { type: "object", required: true, children: podSpec } } },
        parallelism: { type: "number", desc: "Max parallel pods" },
        completions: { type: "number", desc: "Desired completions" },
        completionMode: { type: "string", enum: ["NonIndexed", "Indexed"] },
        backoffLimit: { type: "number", desc: "Retry limit" },
        activeDeadlineSeconds: { type: "number" },
        ttlSecondsAfterFinished: { type: "number", desc: "Auto-delete after completion" },
        suspend: { type: "boolean" },
      },
    },
  },

  CronJob: {
    ...topLevelFields,
    spec: {
      type: "object",
      required: true,
      children: {
        schedule: { type: "string", required: true, desc: "Cron schedule (e.g. '*/5 * * * *')" },
        timeZone: { type: "string", desc: "IANA timezone (e.g. 'America/New_York')" },
        jobTemplate: {
          type: "object",
          required: true,
          children: {
            metadata: { type: "object", children: objectMeta },
            spec: { type: "object", required: true, desc: "Job spec" },
          },
        },
        concurrencyPolicy: { type: "string", enum: ["Allow", "Forbid", "Replace"] },
        suspend: { type: "boolean" },
        successfulJobsHistoryLimit: { type: "number" },
        failedJobsHistoryLimit: { type: "number" },
        startingDeadlineSeconds: { type: "number" },
      },
    },
  },

  HorizontalPodAutoscaler: {
    ...topLevelFields,
    spec: {
      type: "object",
      required: true,
      children: {
        scaleTargetRef: {
          type: "object",
          required: true,
          children: {
            apiVersion: { type: "string", desc: "e.g. apps/v1" },
            kind: { type: "string", required: true, enum: ["Deployment", "StatefulSet", "ReplicaSet"] },
            name: { type: "string", required: true },
          },
        },
        minReplicas: { type: "number", desc: "Minimum replicas" },
        maxReplicas: { type: "number", required: true, desc: "Maximum replicas" },
        metrics: {
          type: "array",
          desc: "Metric targets",
          items: {
            type: "object",
            children: {
              type: { type: "string", required: true, enum: ["Resource", "Pods", "Object", "External"] },
              resource: {
                type: "object",
                children: {
                  name: { type: "string", enum: ["cpu", "memory"] },
                  target: { type: "object", children: { type: { type: "string", enum: ["Utilization", "AverageValue", "Value"] }, averageUtilization: { type: "number" }, averageValue: { type: "string" }, value: { type: "string" } } },
                },
              },
            },
          },
        },
        behavior: {
          type: "object",
          children: {
            scaleUp: { type: "object", children: { stabilizationWindowSeconds: { type: "number" }, policies: { type: "array" }, selectPolicy: { type: "string", enum: ["Max", "Min", "Disabled"] } } },
            scaleDown: { type: "object", children: { stabilizationWindowSeconds: { type: "number" }, policies: { type: "array" }, selectPolicy: { type: "string", enum: ["Max", "Min", "Disabled"] } } },
          },
        },
      },
    },
  },

  Namespace: {
    ...topLevelFields,
    spec: {
      type: "object",
      children: {
        finalizers: { type: "array", items: { type: "string" } },
      },
    },
  },
};
