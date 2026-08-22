import { describe, expect, test } from 'bun:test';
import type { V1ReplicaSet } from '@kubernetes/client-node';

import { revisionTemplateYaml } from './workload-ops';

function rs(template: Record<string, unknown> | undefined): V1ReplicaSet {
  return { metadata: { name: 'web-abc' }, spec: template ? { template } : {} } as unknown as V1ReplicaSet;
}

describe('revisionTemplateYaml', () => {
  test('serializes the pod template and drops the pod-template-hash label', () => {
    const yaml = revisionTemplateYaml(
      rs({
        metadata: { labels: { app: 'web', 'pod-template-hash': '7f9c8d' } },
        spec: { containers: [{ name: 'web', image: 'nginx:1.25' }] },
      }),
    );
    expect(yaml).toContain('app: web');
    expect(yaml).toContain('image: nginx:1.25');
    expect(yaml).not.toContain('pod-template-hash');
  });

  test('removes an emptied labels map and metadata rather than leaving `{}` noise', () => {
    const yaml = revisionTemplateYaml(
      rs({ metadata: { labels: { 'pod-template-hash': 'x' } }, spec: { containers: [] } }),
    );
    expect(yaml).not.toContain('metadata');
    expect(yaml.trim()).toBe('spec:\n  containers: []');
  });

  test('two revisions that differ only by hash produce identical YAML', () => {
    const a = rs({ metadata: { labels: { app: 'web', 'pod-template-hash': 'a' } }, spec: { containers: [{ image: 'x:1' }] } });
    const b = rs({ metadata: { labels: { app: 'web', 'pod-template-hash': 'b' } }, spec: { containers: [{ image: 'x:1' }] } });
    expect(revisionTemplateYaml(a)).toBe(revisionTemplateYaml(b));
  });

  test('a ReplicaSet without a template yields an empty string', () => {
    expect(revisionTemplateYaml(rs(undefined))).toBe('');
  });
});
