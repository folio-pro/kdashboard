import { test, expect, describe } from 'bun:test';

import { describeWatchEnd, resolveWatchTarget, watchPath } from './watch';
import type { CrdInfo } from './crd';

const widget: CrdInfo = {
  group: 'demo.kdash.io',
  version: 'v1alpha1',
  kind: 'Widget',
  plural: 'widgets',
  scope: 'Namespaced',
  short_names: ['wd'],
};
const gadget: CrdInfo = { ...widget, kind: 'Gadget', plural: 'gadgets', scope: 'Cluster' };

const discovery = async (group: string, kind: string): Promise<CrdInfo | undefined> =>
  [widget, gadget].find((c) => c.group === group && c.kind === kind);

describe('resolveWatchTarget — what a watch resource_type maps to', () => {
  test('built-in kinds come from the registry, without touching discovery', async () => {
    const fail = async (): Promise<CrdInfo | undefined> => {
      throw new Error('discovery must not run for a built-in kind');
    };
    const pods = await resolveWatchTarget('pods', fail);
    expect(pods).toEqual({ group: '', version: 'v1', apiVersion: 'v1', kind: 'Pod', plural: 'pods', clusterScoped: false });
    const nodes = await resolveWatchTarget('nodes', fail);
    expect(nodes?.clusterScoped).toBe(true);
  });

  test('a crd:<group>/<Kind> pseudo-type resolves through CRD discovery', async () => {
    const ar = await resolveWatchTarget('crd:demo.kdash.io/Widget', discovery);
    expect(ar).toEqual({
      group: 'demo.kdash.io',
      version: 'v1alpha1',
      apiVersion: 'demo.kdash.io/v1alpha1',
      kind: 'Widget',
      plural: 'widgets',
      clusterScoped: false,
    });
    const cluster = await resolveWatchTarget('crd:demo.kdash.io/Gadget', discovery);
    expect(cluster?.clusterScoped).toBe(true);
  });

  test('unknown built-ins and undiscovered CRDs are undefined (the start rejects)', async () => {
    expect(await resolveWatchTarget('gizmos', discovery)).toBeUndefined();
    expect(await resolveWatchTarget('crd:demo.kdash.io/Nope', discovery)).toBeUndefined();
    expect(await resolveWatchTarget('crd:malformed', discovery)).toBeUndefined();
  });
});

describe('watchPath — where the watch connects', () => {
  test('a namespaced CRD watches its namespace, or the whole cluster with none', async () => {
    const ar = (await resolveWatchTarget('crd:demo.kdash.io/Widget', discovery))!;
    expect(watchPath(ar, 'team-a')).toBe('/apis/demo.kdash.io/v1alpha1/namespaces/team-a/widgets');
    expect(watchPath(ar, undefined)).toBe('/apis/demo.kdash.io/v1alpha1/widgets');
    expect(watchPath(ar, '')).toBe('/apis/demo.kdash.io/v1alpha1/widgets');
  });

  test('a cluster-scoped kind ignores the namespace', async () => {
    const ar = (await resolveWatchTarget('nodes'))!;
    expect(watchPath(ar, 'default')).toBe('/api/v1/nodes');
  });
});

describe('describeWatchEnd — which stream ends the renderer hears about', () => {
  test('a clean close and our own abort are silent', () => {
    expect(describeWatchEnd(null)).toBeNull();
    expect(describeWatchEnd(undefined)).toBeNull();
    const abort = new Error('This operation was aborted');
    abort.name = 'AbortError';
    expect(describeWatchEnd(abort)).toBeNull();
    expect(describeWatchEnd(new Error('The user aborted a request.'))).toBeNull();
  });

  test('a transport failure is reported with its network hint', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6443'), { code: 'ECONNREFUSED' });
    const msg = describeWatchEnd(refused);
    expect(msg).toContain('Cannot reach');
    expect(msg).toContain('[ECONNREFUSED]');
  });

  test('an apiserver status error keeps its message', () => {
    expect(describeWatchEnd(new Error('Service Unavailable'))).toBe('Service Unavailable');
  });
});
