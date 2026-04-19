export function createMockPod(name: string, namespace = "default", status = "Running") {
  return {
    kind: "Pod",
    api_version: "v1",
    metadata: {
      name,
      namespace,
      uid: `pod-uid-${name}`,
      creation_timestamp: new Date(Date.now() - 86400000).toISOString(),
      labels: { app: name },
      annotations: {},
      owner_references: [],
      resource_version: "1",
    },
    spec: {
      containers: [{ name: "main", image: "nginx:latest" }],
    },
    status: {
      phase: status,
      podIP: "10.0.0.1",
      hostIP: "192.168.1.1",
      containerStatuses: [
        {
          name: "main",
          image: "nginx:latest",
          ready: true,
          restartCount: 0,
          state: { running: { startedAt: new Date().toISOString() } },
        },
      ],
    },
  };
}

export function createMockDeployment(name: string, namespace = "default", replicas = 3) {
  return {
    kind: "Deployment",
    api_version: "apps/v1",
    metadata: {
      name,
      namespace,
      uid: `deployment-uid-${name}`,
      creation_timestamp: new Date(Date.now() - 86400000 * 7).toISOString(),
      labels: { app: name },
      annotations: {},
      owner_references: [],
      resource_version: "1",
    },
    spec: {
      replicas,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name } },
        spec: {
          containers: [{ name: "main", image: "nginx:latest", ports: [{ containerPort: 80 }] }],
        },
      },
    },
    status: {
      replicas,
      readyReplicas: replicas,
      availableReplicas: replicas,
      updatedReplicas: replicas,
      conditions: [
        { type: "Available", status: "True", reason: "MinimumReplicasAvailable" },
        { type: "Progressing", status: "True", reason: "NewRollout" },
      ],
    },
  };
}

export function createMockService(name: string, namespace = "default") {
  return {
    kind: "Service",
    api_version: "v1",
    metadata: {
      name,
      namespace,
      uid: `service-uid-${name}`,
      creation_timestamp: new Date(Date.now() - 86400000 * 3).toISOString(),
      labels: { app: name },
      annotations: {},
      owner_references: [],
      resource_version: "1",
    },
    spec: {
      type: "ClusterIP",
      selector: { app: name },
      ports: [{ port: 80, targetPort: 80, protocol: "TCP" }],
    },
    status: {},
  };
}

export function createMockConfigMap(name: string, namespace = "default") {
  return {
    kind: "ConfigMap",
    api_version: "v1",
    metadata: {
      name,
      namespace,
      uid: `configmap-uid-${name}`,
      creation_timestamp: new Date(Date.now() - 86400000 * 5).toISOString(),
      labels: {},
      annotations: {},
      owner_references: [],
      resource_version: "1",
    },
    data: { "config.yaml": "key: value\n" },
  };
}

export function createMockNamespace(name: string) {
  return {
    kind: "Namespace",
    api_version: "v1",
    metadata: {
      name,
      uid: `namespace-uid-${name}`,
      creation_timestamp: new Date(Date.now() - 86400000 * 30).toISOString(),
      labels: {},
      annotations: {},
      owner_references: [],
      resource_version: "1",
    },
    spec: {},
    status: { phase: "Active" },
  };
}

export const MOCK_PODS_LIST = {
  resource_type: "pods",
  items: [
    createMockPod("api-server-v2", "default", "Running"),
    createMockPod("frontend-app", "default", "Running"),
    createMockPod("worker-queue", "default", "Running"),
    createMockPod("cache-redis", "kube-system", "Running"),
  ],
};

export const MOCK_DEPLOYMENTS_LIST = {
  resource_type: "deployments",
  items: [
    createMockDeployment("api-server", "default", 3),
    createMockDeployment("frontend", "default", 2),
    createMockDeployment("worker", "default", 5),
  ],
};

export const MOCK_SERVICES_LIST = {
  resource_type: "services",
  items: [
    createMockService("api-service", "default"),
    createMockService("frontend-service", "default"),
    createMockService("redis", "kube-system"),
  ],
};

export const MOCK_CONFIGMAPS_LIST = {
  resource_type: "configmaps",
  items: [
    createMockConfigMap("app-config", "default"),
    createMockConfigMap("feature-flags", "default"),
  ],
};

export const MOCK_CLUSTER_SUMMARY = {
  current_context: "minikube",
  available_contexts: 2,
  resource_counts: {
    pods: 4,
    deployments: 3,
    services: 3,
    configmaps: 2,
    namespaces: 3,
    statefulsets: 1,
    daemonsets: 1,
  },
  cluster_overview: {
    nodes: 1,
    namespaces: 3,
    pods: 4,
    deployments: 3,
    services: 3,
    statefulsets: 1,
    daemonsets: 1,
    jobs: 0,
  },
};

export const MOCK_TOPOLOGY_GRAPH = {
  nodes: [
    { id: "svc-api", kind: "Service", name: "api-service", namespace: "default", api_version: "v1", status: "Ready", is_ghost: false, depth: 0 },
    { id: "dep-api", kind: "Deployment", name: "api-server", namespace: "default", api_version: "apps/v1", status: "Available", is_ghost: false, depth: 1 },
    { id: "pod-api-1", kind: "Pod", name: "api-server-v2", namespace: "default", api_version: "v1", status: "Running", is_ghost: false, depth: 2 },
    { id: "pod-api-2", kind: "Pod", name: "api-server-abc123", namespace: "default", api_version: "v1", status: "Running", is_ghost: false, depth: 2 },
  ],
  edges: [
    { from: "svc-api", to: "dep-api", edge_type: "selects" },
    { from: "dep-api", to: "pod-api-1", edge_type: "manages" },
    { from: "dep-api", to: "pod-api-2", edge_type: "manages" },
  ],
  root_ids: ["svc-api"],
  has_cycles: false,
  total_resources: 4,
  clustered: true,
  cluster_groups: [],
};

export function createMockActionProposal(
  actionType: string,
  resourceKind: string,
  resourceName: string,
  namespace = "default",
  tier = "green"
) {
  return {
    id: `proposal-${actionType}-${resourceName}-${Date.now()}`,
    action_type: actionType,
    resource_kind: resourceKind,
    resource_name: resourceName,
    namespace,
    params: {},
    tier,
    description: `${actionType} ${resourceKind}/${resourceName}`,
    timestamp: Date.now(),
  };
}

export const GREEN_ACTIONS = [
  createMockActionProposal("get", "pod", "api-server-v2", "default", "green"),
  createMockActionProposal("describe", "deployment", "api-server", "default", "green"),
  createMockActionProposal("logs", "pod", "api-server-v2", "default", "green"),
  createMockActionProposal("events", "pod", "api-server-v2", "default", "green"),
  createMockActionProposal("list", "pods", "", "default", "green"),
];

export const YELLOW_ACTIONS = [
  createMockActionProposal("scale", "deployment", "api-server", "default", "yellow"),
  createMockActionProposal("restart", "deployment", "frontend", "default", "yellow"),
  createMockActionProposal("rollback", "deployment", "worker", "default", "yellow"),
];

export const RED_ACTIONS = [
  createMockActionProposal("delete", "pod", "api-server-v2", "default", "red"),
  createMockActionProposal("delete", "deployment", "api-server", "default", "red"),
  createMockActionProposal("apply", "deployment", "api-server", "default", "red"),
  createMockActionProposal("exec", "pod", "api-server-v2", "default", "red"),
];

export const BLACKED_ACTIONS = [
  createMockActionProposal("delete", "namespace", "kube-system", "", "blacked"),
  createMockActionProposal("delete", "node", "minikube", "", "blacked"),
];
