// NetworkPolicies — pure evaluation of which workloads a namespace's policies
// isolate, what they allow, and which policies select nothing. Fed by the
// handler with the namespace's policies and pods (and every namespace's
// labels for namespaceSelector peers). Wire casing: snake_case.

import type { V1LabelSelector, V1NetworkPolicy, V1NetworkPolicyPeer, V1NetworkPolicyPort, V1Pod } from '@kubernetes/client-node';

import { workloadOf } from './rightsizing';

// ---------------------------------------------------------------------------
// Wire types (mirrored in src/lib/types/netpol.ts)
// ---------------------------------------------------------------------------

export interface PeerSummary {
  /** True when a rule has no `from`/`to` (or an empty peer) — everything is allowed. */
  any: boolean;
  /** Workloads in this namespace the peers match (kind/name). */
  workloads: string[];
  /** Namespaces matched by namespaceSelector peers (names; "*" = every namespace). */
  namespaces: string[];
  cidrs: string[];
  /** Ports named by the rules; empty = all ports. */
  ports: string[];
}

export interface WorkloadPolicyStatus {
  kind: string;
  name: string;
  pod_count: number;
  isolated_ingress: boolean;
  isolated_egress: boolean;
  policies: string[];
  allowed_from: PeerSummary;
  allowed_to: PeerSummary;
}

export interface PolicySummary {
  name: string;
  policy_types: string[];
  /** Workloads (kind/name) whose pods it selects. */
  selects: string[];
  pod_count: number;
  /** Empty podSelector — applies to every pod in the namespace. */
  selects_all: boolean;
  ingress_rules: number;
  egress_rules: number;
}

export interface AllowedFlow {
  /** kind/name of the source workload. */
  from: string;
  /** kind/name of the destination workload. */
  to: string;
  ports: string[];
  policy: string;
}

export interface NetworkPolicyOverview {
  namespace: string;
  policy_count: number;
  default_deny_ingress: boolean;
  default_deny_egress: boolean;
  policies: PolicySummary[];
  workloads: WorkloadPolicyStatus[];
  /** Intra-namespace ingress flows the policies explicitly allow. */
  flows: AllowedFlow[];
  fetched_at: string;
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** Kubernetes label-selector semantics: matchLabels AND every matchExpression. */
export function selectorMatches(selector: V1LabelSelector | undefined, labels: Record<string, string> | undefined): boolean {
  if (!selector) return false; // null selector selects nothing (a peer with no selector is handled by the caller)
  const l = labels ?? {};
  for (const [k, v] of Object.entries(selector.matchLabels ?? {})) if (l[k] !== v) return false;
  for (const e of selector.matchExpressions ?? []) {
    const has = Object.prototype.hasOwnProperty.call(l, e.key);
    const values = e.values ?? [];
    switch (e.operator) {
      case 'In': if (!has || !values.includes(l[e.key])) return false; break;
      case 'NotIn': if (has && values.includes(l[e.key])) return false; break;
      case 'Exists': if (!has) return false; break;
      case 'DoesNotExist': if (has) return false; break;
      default: return false;
    }
  }
  return true;
}

/** An empty selector `{}` matches everything; undefined matches nothing. */
function isEmptySelector(s: V1LabelSelector | undefined): boolean {
  return !!s && !Object.keys(s.matchLabels ?? {}).length && !(s.matchExpressions ?? []).length;
}

export function policyTypesOf(p: V1NetworkPolicy): string[] {
  const explicit = p.spec?.policyTypes;
  if (explicit && explicit.length) return explicit;
  const types = ['Ingress'];
  if (p.spec?.egress && p.spec.egress.length) types.push('Egress');
  return types;
}

function portLabel(p: V1NetworkPolicyPort): string {
  const proto = p.protocol && p.protocol !== 'TCP' ? `${p.protocol}/` : '';
  if (p.port === undefined) return `${proto}*`;
  return `${proto}${String(p.port)}${p.endPort ? `-${p.endPort}` : ''}`;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface NetpolInput {
  namespace: string;
  policies: V1NetworkPolicy[];
  pods: V1Pod[];
  /** Every namespace's labels, for namespaceSelector peers. */
  namespaces: Array<{ name: string; labels: Record<string, string> }>;
}

interface Workload {
  key: string;
  kind: string;
  name: string;
  pods: V1Pod[];
}

function groupWorkloads(pods: V1Pod[]): Map<string, Workload> {
  const map = new Map<string, Workload>();
  for (const pod of pods) {
    if (pod.metadata?.deletionTimestamp) continue;
    const ref = workloadOf(pod);
    const key = `${ref.kind}/${ref.name}`;
    const w = map.get(key) ?? { key, kind: ref.kind, name: ref.name, pods: [] };
    w.pods.push(pod);
    map.set(key, w);
  }
  return map;
}

/** Workloads a peer's podSelector matches within this namespace. */
function peerWorkloads(peer: V1NetworkPolicyPeer, workloads: Workload[], namespace: string, namespaces: NetpolInput['namespaces']): string[] {
  // A namespaceSelector that does not include THIS namespace cannot name local workloads.
  if (peer.namespaceSelector) {
    const self = namespaces.find((n) => n.name === namespace);
    const selfMatches = isEmptySelector(peer.namespaceSelector) || selectorMatches(peer.namespaceSelector, self?.labels);
    if (!selfMatches) return [];
    if (!peer.podSelector) return workloads.map((w) => w.key);
  }
  if (!peer.podSelector) return [];
  if (isEmptySelector(peer.podSelector)) return workloads.map((w) => w.key);
  return workloads.filter((w) => w.pods.some((p) => selectorMatches(peer.podSelector, p.metadata?.labels))).map((w) => w.key);
}

function peerNamespaces(peer: V1NetworkPolicyPeer, namespaces: NetpolInput['namespaces']): string[] {
  if (!peer.namespaceSelector) return [];
  if (isEmptySelector(peer.namespaceSelector)) return ['*'];
  return namespaces.filter((n) => selectorMatches(peer.namespaceSelector, n.labels)).map((n) => n.name);
}

/** client-node names the ingress peer list `_from` (`from` is reserved in its generator); raw JSON says `from`. */
function fromOf(rule: { _from?: V1NetworkPolicyPeer[]; from?: V1NetworkPolicyPeer[] }): V1NetworkPolicyPeer[] | undefined {
  return rule._from ?? rule.from;
}

function emptyPeer(): PeerSummary {
  return { any: false, workloads: [], namespaces: [], cidrs: [], ports: [] };
}

function addPeer(into: PeerSummary, peers: V1NetworkPolicyPeer[] | undefined, ports: V1NetworkPolicyPort[] | undefined, ctx: { workloads: Workload[]; namespace: string; namespaces: NetpolInput['namespaces'] }): void {
  for (const p of ports ?? []) {
    const l = portLabel(p);
    if (!into.ports.includes(l)) into.ports.push(l);
  }
  if (!peers || peers.length === 0) {
    into.any = true;
    return;
  }
  for (const peer of peers) {
    if (peer.ipBlock) {
      const c = peer.ipBlock.cidr + (peer.ipBlock.except?.length ? ` except ${peer.ipBlock.except.join(',')}` : '');
      if (!into.cidrs.includes(c)) into.cidrs.push(c);
    }
    for (const w of peerWorkloads(peer, ctx.workloads, ctx.namespace, ctx.namespaces)) if (!into.workloads.includes(w)) into.workloads.push(w);
    for (const n of peerNamespaces(peer, ctx.namespaces)) if (!into.namespaces.includes(n)) into.namespaces.push(n);
    if (!peer.ipBlock && !peer.podSelector && !peer.namespaceSelector) into.any = true;
  }
}

export function evaluateNetworkPolicies(input: NetpolInput, now: () => string = () => new Date().toISOString()): NetworkPolicyOverview {
  const workloadMap = groupWorkloads(input.pods);
  const workloads = [...workloadMap.values()].sort((a, b) => a.key.localeCompare(b.key));
  const ctx = { workloads, namespace: input.namespace, namespaces: input.namespaces };

  const status = new Map<string, WorkloadPolicyStatus>();
  for (const w of workloads) {
    status.set(w.key, { kind: w.kind, name: w.name, pod_count: w.pods.length, isolated_ingress: false, isolated_egress: false, policies: [], allowed_from: emptyPeer(), allowed_to: emptyPeer() });
  }

  const policies: PolicySummary[] = [];
  const flows: AllowedFlow[] = [];
  let defaultDenyIngress = false;
  let defaultDenyEgress = false;

  for (const p of [...input.policies].sort((a, b) => (a.metadata?.name ?? '').localeCompare(b.metadata?.name ?? ''))) {
    const name = p.metadata?.name ?? '';
    const types = policyTypesOf(p);
    const selectsAll = !p.spec?.podSelector || isEmptySelector(p.spec.podSelector);
    const selected = selectsAll ? workloads : workloads.filter((w) => w.pods.some((pod) => selectorMatches(p.spec?.podSelector, pod.metadata?.labels)));
    const ingress = p.spec?.ingress ?? [];
    const egress = p.spec?.egress ?? [];
    if (selectsAll && types.includes('Ingress') && ingress.length === 0) defaultDenyIngress = true;
    if (selectsAll && types.includes('Egress') && egress.length === 0) defaultDenyEgress = true;

    policies.push({
      name,
      policy_types: types,
      selects: selected.map((w) => w.key),
      pod_count: selected.reduce((n, w) => n + w.pods.length, 0),
      selects_all: selectsAll,
      ingress_rules: ingress.length,
      egress_rules: egress.length,
    });

    for (const w of selected) {
      const st = status.get(w.key)!;
      st.policies.push(name);
      if (types.includes('Ingress')) {
        st.isolated_ingress = true;
        for (const rule of ingress) {
          const from = fromOf(rule as { _from?: V1NetworkPolicyPeer[]; from?: V1NetworkPolicyPeer[] });
          addPeer(st.allowed_from, from, rule.ports, ctx);
          const ports = (rule.ports ?? []).map(portLabel);
          const sources = !from || from.length === 0 ? workloads.map((x) => x.key) : from.flatMap((peer) => peerWorkloads(peer, workloads, input.namespace, input.namespaces));
          for (const src of new Set(sources)) {
            if (src === w.key) continue;
            if (!flows.some((f) => f.from === src && f.to === w.key && f.policy === name)) flows.push({ from: src, to: w.key, ports, policy: name });
          }
        }
      }
      if (types.includes('Egress')) {
        st.isolated_egress = true;
        for (const rule of egress) addPeer(st.allowed_to, rule.to, rule.ports, ctx);
      }
    }
  }

  return {
    namespace: input.namespace,
    policy_count: input.policies.length,
    default_deny_ingress: defaultDenyIngress,
    default_deny_egress: defaultDenyEgress,
    policies,
    workloads: [...status.values()],
    flows,
    fetched_at: now(),
  };
}
