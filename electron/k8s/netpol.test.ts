import { describe, expect, test } from 'bun:test';
import type { V1NetworkPolicy, V1Pod } from '@kubernetes/client-node';

import { evaluateNetworkPolicies, policyTypesOf, selectorMatches } from './netpol';

const pod = (name: string, labels: Record<string, string>, owner?: { kind: string; name: string }): V1Pod =>
  ({ metadata: { name, namespace: 'shop', labels, ownerReferences: owner ? [{ kind: owner.kind, name: owner.name, controller: true }] : [] }, spec: {}, status: {} }) as unknown as V1Pod;
const pods = [
  pod('web-abc-1', { app: 'web', tier: 'frontend' }, { kind: 'ReplicaSet', name: 'web-abc' }),
  pod('web-abc-2', { app: 'web', tier: 'frontend' }, { kind: 'ReplicaSet', name: 'web-abc' }),
  pod('api-def-1', { app: 'api', tier: 'backend' }, { kind: 'ReplicaSet', name: 'api-def' }),
  pod('db-0', { app: 'db' }, { kind: 'StatefulSet', name: 'db' }),
  pod('batch-x', { job: 'x' }),
];
const policy = (name: string, spec: V1NetworkPolicy['spec']): V1NetworkPolicy => ({ metadata: { name, namespace: 'shop' }, spec }) as V1NetworkPolicy;
const NAMESPACES = [{ name: 'shop', labels: { team: 'shop' } }, { name: 'monitoring', labels: { team: 'platform', role: 'monitoring' } }];

describe('selectorMatches / policyTypesOf', () => {
  test('matchLabels and matchExpressions', () => {
    expect(selectorMatches({ matchLabels: { app: 'web' } }, { app: 'web', x: 'y' })).toBe(true);
    expect(selectorMatches({ matchLabels: { app: 'web' } }, { app: 'api' })).toBe(false);
    expect(selectorMatches({ matchExpressions: [{ key: 'tier', operator: 'In', values: ['frontend', 'edge'] }] }, { tier: 'frontend' })).toBe(true);
    expect(selectorMatches({ matchExpressions: [{ key: 'tier', operator: 'NotIn', values: ['frontend'] }] }, { tier: 'frontend' })).toBe(false);
    expect(selectorMatches({ matchExpressions: [{ key: 'job', operator: 'Exists' }] }, { job: 'x' })).toBe(true);
    expect(selectorMatches({ matchExpressions: [{ key: 'job', operator: 'DoesNotExist' }] }, { job: 'x' })).toBe(false);
    expect(selectorMatches(undefined, { a: 'b' })).toBe(false);
  });
  test('policyTypes default to Ingress, plus Egress when egress rules exist', () => {
    expect(policyTypesOf(policy('p', { podSelector: {} }))).toEqual(['Ingress']);
    expect(policyTypesOf(policy('p', { podSelector: {}, egress: [{}] }))).toEqual(['Ingress', 'Egress']);
    expect(policyTypesOf(policy('p', { podSelector: {}, policyTypes: ['Egress'] }))).toEqual(['Egress']);
  });
});

describe('evaluateNetworkPolicies', () => {
  test('no policies: nothing isolated, no default deny', () => {
    const o = evaluateNetworkPolicies({ namespace: 'shop', policies: [], pods, namespaces: NAMESPACES }, () => 't');
    expect(o.workloads.map((w) => [w.kind, w.name, w.pod_count])).toEqual([
      ['Deployment', 'api', 1], ['Deployment', 'web', 2], ['Pod', 'batch-x', 1], ['StatefulSet', 'db', 1],
    ]);
    expect(o.workloads.every((w) => !w.isolated_ingress && !w.isolated_egress)).toBe(true);
    expect(o.default_deny_ingress).toBe(false);
  });

  test('default deny, a targeted allow rule, flows, ports, cidrs, namespaces and unused policies', () => {
    const policies = [
      policy('default-deny', { podSelector: {}, policyTypes: ['Ingress', 'Egress'] }),
      policy('api-allow-web', { podSelector: { matchLabels: { app: 'api' } }, ingress: [{ _from: [{ podSelector: { matchLabels: { app: 'web' } } }], ports: [{ port: 8080 }] }] } as never),
      policy('db-allow-api-and-monitoring', {
        podSelector: { matchLabels: { app: 'db' } },
        ingress: [
          { from: [{ podSelector: { matchLabels: { app: 'api' } } }], ports: [{ port: 5432 }] },
          { from: [{ namespaceSelector: { matchLabels: { role: 'monitoring' } } }], ports: [{ port: 9187 }] },
          { from: [{ ipBlock: { cidr: '10.0.0.0/8', except: ['10.0.1.0/24'] } }] },
        ],
        egress: [{ to: [{ namespaceSelector: {} }], ports: [{ port: 53, protocol: 'UDP' }] }],
      }),
      policy('orphan', { podSelector: { matchLabels: { app: 'nothing' } } }),
    ];
    const o = evaluateNetworkPolicies({ namespace: 'shop', policies, pods, namespaces: NAMESPACES }, () => 't');
    expect(o.default_deny_ingress).toBe(true);
    expect(o.default_deny_egress).toBe(true);
    const byName = Object.fromEntries(o.policies.map((p) => [p.name, p]));
    expect(byName['default-deny'].selects_all).toBe(true);
    expect(byName['default-deny'].pod_count).toBe(5);
    expect(byName['orphan'].selects).toEqual([]);
    expect(byName['api-allow-web'].selects).toEqual(['Deployment/api']);

    const api = o.workloads.find((w) => w.name === 'api')!;
    expect(api.isolated_ingress).toBe(true);
    expect(api.policies).toEqual(['api-allow-web', 'default-deny']);
    expect(api.allowed_from).toEqual({ any: false, workloads: ['Deployment/web'], namespaces: [], cidrs: [], ports: ['8080'] });

    const db = o.workloads.find((w) => w.name === 'db')!;
    expect(db.allowed_from.workloads).toEqual(['Deployment/api']);
    expect(db.allowed_from.namespaces).toEqual(['monitoring']);
    expect(db.allowed_from.cidrs).toEqual(['10.0.0.0/8 except 10.0.1.0/24']);
    expect(db.allowed_from.ports.sort()).toEqual(['5432', '9187']);
    expect(db.allowed_to).toEqual({ any: false, workloads: ['Deployment/api', 'Deployment/web', 'Pod/batch-x', 'StatefulSet/db'], namespaces: ['*'], cidrs: [], ports: ['UDP/53'] });

    expect(o.flows).toEqual([
      { from: 'Deployment/web', to: 'Deployment/api', ports: ['8080'], policy: 'api-allow-web' },
      { from: 'Deployment/api', to: 'StatefulSet/db', ports: ['5432'], policy: 'db-allow-api-and-monitoring' },
    ]);
  });

  test('an allow-all ingress rule reads as any and flows from every other workload', () => {
    const o = evaluateNetworkPolicies({ namespace: 'shop', policies: [policy('open', { podSelector: { matchLabels: { app: 'web' } }, ingress: [{}] })], pods, namespaces: NAMESPACES }, () => 't');
    const web = o.workloads.find((w) => w.name === 'web')!;
    expect(web.allowed_from.any).toBe(true);
    expect(o.flows.filter((f) => f.to === 'Deployment/web').map((f) => f.from).sort()).toEqual(['Deployment/api', 'Pod/batch-x', 'StatefulSet/db']);
  });
});
