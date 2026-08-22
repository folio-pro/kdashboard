import { describe, expect, test } from 'bun:test';

import {
  mergeKubeconfig,
  parseKubeconfig,
  previewMerge,
  removeContext,
  summarizeKubeconfig,
  type KubeconfigDoc,
} from './kubeconfig-merge';

const cluster = (name: string, server: string) => ({ name, cluster: { server } });
const user = (name: string, token: string) => ({ name, user: { token } });
const context = (name: string, c: string, u: string, namespace?: string) => ({
  name,
  context: { cluster: c, user: u, ...(namespace ? { namespace } : {}) },
});

const TARGET: KubeconfigDoc = {
  apiVersion: 'v1',
  kind: 'Config',
  'current-context': 'dev',
  preferences: { colors: true },
  clusters: [cluster('dev-cl', 'https://dev:6443'), cluster('shared', 'https://shared:6443')],
  users: [user('dev-user', 'd'), user('shared-user', 's')],
  contexts: [context('dev', 'dev-cl', 'dev-user'), context('shared', 'shared', 'shared-user')],
};

const SOURCE: KubeconfigDoc = {
  apiVersion: 'v1',
  kind: 'Config',
  'current-context': 'prod',
  clusters: [cluster('prod-cl', 'https://prod:6443'), cluster('shared', 'https://shared-NEW:6443')],
  users: [user('prod-user', 'p'), user('shared-user', 's')],
  contexts: [
    context('prod', 'prod-cl', 'prod-user', 'payments'),
    context('shared', 'shared', 'shared-user'),
    context('staging', 'prod-cl', 'prod-user'),
  ],
};

describe('parseKubeconfig', () => {
  test('accepts a kubeconfig and rejects non-kubeconfig documents', () => {
    expect(summarizeKubeconfig(parseKubeconfig('contexts: [{name: a, context: {cluster: c, user: u}}]'))).toHaveLength(1);
    expect(() => parseKubeconfig('just a string')).toThrow(/expected a YAML mapping/);
    expect(() => parseKubeconfig('foo: bar')).toThrow(/no clusters, users or contexts/);
    expect(() => parseKubeconfig('a: [')).toThrow(/Not valid kubeconfig YAML/);
  });
});

describe('summarizeKubeconfig', () => {
  test('joins each context with its cluster server', () => {
    expect(summarizeKubeconfig(SOURCE)).toEqual([
      { name: 'prod', cluster: 'prod-cl', user: 'prod-user', server: 'https://prod:6443', namespace: 'payments' },
      { name: 'shared', cluster: 'shared', user: 'shared-user', server: 'https://shared-NEW:6443', namespace: undefined },
      { name: 'staging', cluster: 'prod-cl', user: 'prod-user', server: 'https://prod:6443', namespace: undefined },
    ]);
  });
});

describe('previewMerge', () => {
  test('classifies each incoming context as new, identical or conflicting', () => {
    expect(previewMerge(TARGET, SOURCE).map((r) => [r.name, r.status])).toEqual([
      ['prod', 'new'],
      ['shared', 'conflict'], // same context, but the cluster server differs
      ['staging', 'new'],
    ]);
    const identical: KubeconfigDoc = { ...SOURCE, clusters: [cluster('shared', 'https://shared:6443')] };
    expect(previewMerge(TARGET, identical).find((r) => r.name === 'shared')?.status).toBe('identical');
  });
});

describe('mergeKubeconfig', () => {
  test('adds what is missing, keeps existing entries, preserves unrelated keys and current-context', () => {
    const r = mergeKubeconfig(TARGET, SOURCE);
    expect(r.contexts).toEqual({ added: ['prod', 'staging'], replaced: [], skipped: ['shared'] });
    expect(r.clusters).toEqual({ added: ['prod-cl'], replaced: [], skipped: ['shared'] });
    expect(r.users).toEqual({ added: ['prod-user'], replaced: [], skipped: ['shared-user'] });
    expect(r.merged['current-context']).toBe('dev');
    expect(r.merged.preferences).toEqual({ colors: true });
    expect((r.merged.clusters as Array<{ name: string; cluster: { server: string } }>).find((c) => c.name === 'shared')?.cluster.server).toBe('https://shared:6443');
    // The inputs are untouched.
    expect((TARGET.contexts as unknown[]).length).toBe(2);
  });

  test('overwrite replaces differing entries and reports them', () => {
    const r = mergeKubeconfig(TARGET, SOURCE, { overwrite: true });
    expect(r.clusters.replaced).toEqual(['shared']);
    expect(r.contexts.skipped).toEqual(['shared']); // identical context entry → nothing to replace
    expect((r.merged.clusters as Array<{ name: string; cluster: { server: string } }>).find((c) => c.name === 'shared')?.cluster.server).toBe('https://shared-NEW:6443');
  });

  test('a context subset only brings the clusters and users it needs', () => {
    const r = mergeKubeconfig(TARGET, SOURCE, { contexts: ['prod'] });
    expect(r.contexts.added).toEqual(['prod']);
    expect(r.clusters.added).toEqual(['prod-cl']);
    expect(r.users.added).toEqual(['prod-user']);
    expect(r.clusters.skipped).toEqual([]); // 'shared' was not even considered
  });

  test('an empty target takes the source current-context and kind', () => {
    const r = mergeKubeconfig({}, SOURCE);
    expect(r.merged['current-context']).toBe('prod');
    expect(r.merged.kind).toBe('Config');
    expect(r.contexts.added).toHaveLength(3);
  });
});

describe('removeContext', () => {
  test('drops the context and its now-orphaned cluster and user', () => {
    const r = removeContext(TARGET, 'dev');
    expect((r.doc.contexts as Array<{ name: string }>).map((c) => c.name)).toEqual(['shared']);
    expect(r.removedCluster).toBe('dev-cl');
    expect(r.removedUser).toBe('dev-user');
    expect(r.clearedCurrent).toBe(true);
    expect(r.doc['current-context']).toBeUndefined();
  });

  test('keeps a cluster or user another context still references', () => {
    const r = removeContext(SOURCE, 'staging');
    expect(r.removedCluster).toBeUndefined();
    expect(r.removedUser).toBeUndefined();
    expect(r.clearedCurrent).toBe(false);
    expect((r.doc.clusters as unknown[]).length).toBe(2);
  });

  test('rejects an unknown context', () => {
    expect(() => removeContext(TARGET, 'nope')).toThrow('Context not found: nope');
  });
});
