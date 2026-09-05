// NetworkPolicy overview for the topology's policy layer.
//
// Commands:
//   - get_network_policies  { namespace: string } -> NetworkPolicyOverview
//
// Lists the namespace's NetworkPolicies and pods, plus every namespace's
// labels (namespaceSelector peers); the evaluation is electron/k8s/netpol.ts.

import type { HandlerCtx, HandlerMap } from '../dispatch';
import { getCoreV1Api, getNetworkingV1Api } from '../k8s/client';
import { evaluateNetworkPolicies } from '../k8s/netpol';

export function register(handlers: HandlerMap, _ctx: HandlerCtx): void {
  handlers.set('get_network_policies', async (args) => {
    const namespace = typeof args.namespace === 'string' ? args.namespace : '';
    if (!namespace) throw new Error('get_network_policies: a namespace is required');
    const core = getCoreV1Api();
    const [policies, pods, namespaces] = await Promise.all([
      getNetworkingV1Api().listNamespacedNetworkPolicy({ namespace }).then((l) => l.items),
      core.listNamespacedPod({ namespace }).then((l) => l.items),
      core
        .listNamespace()
        .then((l) => l.items.map((n) => ({ name: n.metadata?.name ?? '', labels: n.metadata?.labels ?? {} })))
        .catch(() => [{ name: namespace, labels: {} }]),
    ]);
    return evaluateNetworkPolicies({ namespace, policies, pods, namespaces });
  });
}
