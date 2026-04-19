import type { Resource, ResourceList, Event } from './kubernetes';
import type { DiagnosticResult } from './cluster';

export interface NamespaceTroubleshootingSnapshot {
  namespace: string;
  candidates: ResourceList | null;
  restartedPods: Array<{ pod: string; namespace: string; restarts: number; status: string }> | null;
  warningEvents: Event[] | null;
  suspectedPod: Resource | null;
  suspectedPodDiagnosis: DiagnosticResult | null;
  suspectedPodEvents: Event[] | null;
  suspectedPodPreviousLogs: string | null;
}

export interface ContainerResourceSummary {
  name: string;
  cpuRequest: string | null;
  cpuLimit: string | null;
  memoryRequest: string | null;
  memoryLimit: string | null;
}

export interface PodResourceSummary {
  pod: string;
  namespace: string;
  status: string;
  ownerKind: string | null;
  ownerName: string | null;
  containers: ContainerResourceSummary[];
}

export interface WorkloadRef {
  kind: string;
  name: string;
  namespace: string;
}

export interface NamespaceResourceLimitsSnapshot {
  namespace: string;
  pods: PodResourceSummary[];
  podsMissingRequests: number;
  podsMissingLimits: number;
  commonOwner: WorkloadRef | null;
  ownerYaml: string | null;
}
