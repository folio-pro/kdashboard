import type { Resource } from "$lib/types";

export interface RelatedResource {
  kind: string;
  name: string;
  resourceType: string; // sidebar resource type for navigation
}

/** Map K8s Kind to sidebar resourceType */
const KIND_TO_RESOURCE_TYPE: Record<string, string> = {
  Pod: "pods",
  Deployment: "deployments",
  ReplicaSet: "replicasets",
  StatefulSet: "statefulsets",
  DaemonSet: "daemonsets",
  Job: "jobs",
  CronJob: "cronjobs",
  Service: "services",
  Ingress: "ingresses",
  ConfigMap: "configmaps",
  Secret: "secrets",
  Node: "nodes",
  Namespace: "namespaces",
  PersistentVolume: "persistentvolumes",
  PersistentVolumeClaim: "persistentvolumeclaims",
  StorageClass: "storageclasses",
  HorizontalPodAutoscaler: "hpa",
  VerticalPodAutoscaler: "vpa",
  Role: "roles",
  RoleBinding: "rolebindings",
  ClusterRole: "clusterroles",
  ClusterRoleBinding: "clusterrolebindings",
  NetworkPolicy: "networkpolicies",
  ResourceQuota: "resourcequotas",
  LimitRange: "limitranges",
  PodDisruptionBudget: "poddisruptionbudgets",
};

/** Convert a K8s Kind to a sidebar resource type string */
export function kindToResourceType(kind: string): string {
  return KIND_TO_RESOURCE_TYPE[kind] ?? kind.toLowerCase() + "s";
}

function rel(kind: string, name: string): RelatedResource | null {
  const resourceType = KIND_TO_RESOURCE_TYPE[kind];
  if (!resourceType) return null;
  return { kind, name, resourceType };
}

/** Resource types that can be matched to Services via label selectors */
const SERVICE_MATCHABLE_TYPES = new Set(["pods", "deployments", "replicasets", "statefulsets", "daemonsets"]);

/** Check if a service's selector matches a resource's labels */
function selectorMatchesLabels(selector: Record<string, string>, labels: Record<string, string>): boolean {
  for (const [key, val] of Object.entries(selector)) {
    if (labels[key] !== val) return false;
  }
  return true;
}

/** Extract related resources from a resource's own spec/status/metadata.
 *  Pass allServices to enable reverse Service→Pod/Deployment matching. */
export function getRelatedResources(
  resource: Resource,
  resourceType: string,
  allServices?: Resource[],
): RelatedResource[] {
  const related: RelatedResource[] = [];
  const seen = new Set<string>();

  function add(r: RelatedResource | null) {
    if (!r) return;
    const key = `${r.kind}/${r.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    related.push(r);
  }

  // Owner references (all resource types)
  for (const ref of resource.metadata.owner_references ?? []) {
    add(rel(ref.kind, ref.name));
  }

  const spec = resource.spec ?? {};
  const status = resource.status ?? {};

  switch (resourceType) {
    case "pods": {
      // Node
      const nodeName = (spec.nodeName as string) ?? (status.nodeName as string);
      if (nodeName) add(rel("Node", nodeName));

      // ServiceAccount
      const sa = spec.serviceAccountName as string;
      if (sa && sa !== "default") add({ kind: "SA", name: sa, resourceType: "" });

      // Volumes → ConfigMaps, Secrets, PVCs
      const volumes = spec.volumes as Array<Record<string, unknown>> | undefined;
      if (volumes) {
        for (const vol of volumes) {
          const cm = vol.configMap as { name?: string } | undefined;
          if (cm?.name) add(rel("ConfigMap", cm.name));

          const secret = vol.secret as { secretName?: string } | undefined;
          if (secret?.secretName) add(rel("Secret", secret.secretName));

          const pvc = vol.persistentVolumeClaim as { claimName?: string } | undefined;
          if (pvc?.claimName) add(rel("PersistentVolumeClaim", pvc.claimName));

          const projected = vol.projected as { sources?: Array<Record<string, unknown>> } | undefined;
          if (projected?.sources) {
            for (const src of projected.sources) {
              const pcm = src.configMap as { name?: string } | undefined;
              if (pcm?.name) add(rel("ConfigMap", pcm.name));
              const psec = src.secret as { name?: string } | undefined;
              if (psec?.name) add(rel("Secret", psec.name));
            }
          }
        }
      }

      // EnvFrom → ConfigMaps, Secrets
      const containers = spec.containers as Array<Record<string, unknown>> | undefined;
      if (containers) {
        for (const container of containers) {
          const envFrom = container.envFrom as Array<Record<string, unknown>> | undefined;
          if (envFrom) {
            for (const ef of envFrom) {
              const cmRef = ef.configMapRef as { name?: string } | undefined;
              if (cmRef?.name) add(rel("ConfigMap", cmRef.name));
              const secRef = ef.secretRef as { name?: string } | undefined;
              if (secRef?.name) add(rel("Secret", secRef.name));
            }
          }
        }
      }
      break;
    }

    case "services": {
      // Selector labels (shown as info, not navigable)
      // ExternalName target
      const externalName = spec.externalName as string;
      if (externalName) add({ kind: "Ext", name: externalName, resourceType: "" });
      break;
    }

    case "statefulsets": {
      // serviceName → Service
      const svcName = spec.serviceName as string;
      if (svcName) add(rel("Service", svcName));

      // volumeClaimTemplates → PVCs (template names)
      const vcts = spec.volumeClaimTemplates as Array<{ metadata?: { name?: string } }> | undefined;
      if (vcts) {
        for (const vct of vcts) {
          if (vct.metadata?.name) add({ kind: "PVC Template", name: vct.metadata.name, resourceType: "" });
        }
      }
      break;
    }

    case "hpa": {
      // scaleTargetRef
      const target = spec.scaleTargetRef as { kind?: string; name?: string } | undefined;
      if (target?.kind && target?.name) add(rel(target.kind, target.name));
      break;
    }

    case "vpa": {
      // targetRef
      const target = spec.targetRef as { kind?: string; name?: string } | undefined;
      if (target?.kind && target?.name) add(rel(target.kind, target.name));
      break;
    }

    case "ingresses": {
      // defaultBackend
      const defaultBackend = spec.defaultBackend as { service?: { name?: string } } | undefined;
      if (defaultBackend?.service?.name) add(rel("Service", defaultBackend.service.name));

      // rules[].http.paths[].backend.service.name
      const rules = spec.rules as Array<{ http?: { paths?: Array<{ backend?: { service?: { name?: string } } }> } }> | undefined;
      if (rules) {
        for (const rule of rules) {
          for (const path of rule.http?.paths ?? []) {
            const svcName = path.backend?.service?.name;
            if (svcName) add(rel("Service", svcName));
          }
        }
      }

      // tls[].secretName
      const tls = spec.tls as Array<{ secretName?: string }> | undefined;
      if (tls) {
        for (const t of tls) {
          if (t.secretName) add(rel("Secret", t.secretName));
        }
      }
      break;
    }

    case "persistentvolumeclaims": {
      // volumeName → PV
      const volumeName = spec.volumeName as string;
      if (volumeName) add(rel("PersistentVolume", volumeName));

      // storageClassName
      const sc = spec.storageClassName as string;
      if (sc) add(rel("StorageClass", sc));
      break;
    }

    case "persistentvolumes": {
      // claimRef → PVC
      const claimRef = spec.claimRef as { name?: string; namespace?: string } | undefined;
      if (claimRef?.name) add(rel("PersistentVolumeClaim", claimRef.name));

      // storageClassName
      const sc = spec.storageClassName as string;
      if (sc) add(rel("StorageClass", sc));
      break;
    }

    case "rolebindings":
    case "clusterrolebindings": {
      // roleRef
      const roleRef = spec.roleRef as { kind?: string; name?: string } | undefined;
      if (roleRef?.kind && roleRef?.name) add(rel(roleRef.kind, roleRef.name));

      // subjects
      const subjects = spec.subjects as Array<{ kind?: string; name?: string }> | undefined;
      if (subjects) {
        for (const s of subjects) {
          if (s.kind === "ServiceAccount" && s.name) {
            add({ kind: "SA", name: s.name, resourceType: "" });
          }
        }
      }
      break;
    }

  }

  // Reverse match: find Services whose selector matches this resource's labels
  if (allServices && resource.metadata.labels) {
    const labels = resource.metadata.labels;
    if (SERVICE_MATCHABLE_TYPES.has(resourceType)) {
      for (const svc of allServices) {
        const selector = svc.spec?.selector as Record<string, string> | undefined;
        if (selector && Object.keys(selector).length > 0 && selectorMatchesLabels(selector, labels)) {
          add(rel("Service", svc.metadata.name));
        }
      }
    }
  }

  return related;
}

/** Human-readable kind label for display (no abbreviations).
 *  Internal short kinds (SA, Ext) are expanded; everything else passes through. */
export function displayKind(kind: string): string {
  switch (kind) {
    case "SA": return "ServiceAccount";
    case "Ext": return "ExternalName";
    default: return kind;
  }
}
