// Pod → owning workload. One implementation for every feature that groups
// pods by what created them (rightsizing, network policies, the overview).
// Mirror of the renderer's `podWorkload` in src/lib/utils/pod-status.ts —
// edit both together.

import type { V1ObjectMeta, V1OwnerReference, V1Pod } from '@kubernetes/client-node';

export interface WorkloadRef {
  kind: string;
  name: string;
}

/** The controlling owner reference (falls back to the first one). */
export function controllerRef(meta: V1ObjectMeta | undefined): V1OwnerReference | null {
  const refs = meta?.ownerReferences ?? [];
  return refs.find((r) => r.controller) ?? refs[0] ?? null;
}

/**
 * The workload behind an owner reference: a ReplicaSet is (by convention)
 * a Deployment's and is named `<deployment>-<pod-template-hash>`, so the
 * Deployment is the name minus its last segment; anything else is itself.
 */
export function workloadOfRef(ref: Pick<V1OwnerReference, 'kind' | 'name'>): WorkloadRef {
  if (ref.kind === 'ReplicaSet') {
    const idx = ref.name.lastIndexOf('-');
    return { kind: 'Deployment', name: idx > 0 ? ref.name.slice(0, idx) : ref.name };
  }
  return { kind: ref.kind, name: ref.name };
}

/** The workload a pod belongs to, or the pod itself when nothing owns it. */
export function workloadOf(pod: Pick<V1Pod, 'metadata'>): WorkloadRef {
  const ref = controllerRef(pod.metadata);
  return ref ? workloadOfRef(ref) : { kind: 'Pod', name: pod.metadata?.name ?? '' };
}

export function workloadKey(ref: WorkloadRef): string {
  return `${ref.kind}/${ref.name}`;
}
