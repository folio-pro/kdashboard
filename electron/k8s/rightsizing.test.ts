import { describe, expect, test } from 'bun:test';
import type { V1Pod } from '@kubernetes/client-node';

import {
  buildRightsizing,
  recommendCpu,
  recommendMemory,
  roundCpu,
  roundMemory,
  summarize,
  usageKey,
  verdictFor,
  workloadOf,
  worstVerdict,
  type UsageSample,
} from './rightsizing';

const MI = 1024 * 1024;
const pod = (name: string, ns: string, owner: { kind: string; name: string } | null, containers: Array<{ name: string; cpu?: string; memory?: string; cpuLimit?: string }>, phase = 'Running'): V1Pod =>
  ({
    metadata: { name, namespace: ns, ownerReferences: owner ? [{ kind: owner.kind, name: owner.name, controller: true }] : [] },
    spec: { containers: containers.map((c) => ({ name: c.name, resources: { requests: { ...(c.cpu ? { cpu: c.cpu } : {}), ...(c.memory ? { memory: c.memory } : {}) }, ...(c.cpuLimit ? { limits: { cpu: c.cpuLimit } } : {}) } })) },
    status: { phase },
  }) as unknown as V1Pod;

const sample = (ns: string, p: string, c: string, cpu: number | null, memory: number | null): [string, UsageSample] => [usageKey(ns, p, c), { namespace: ns, pod: p, container: c, cpu, memory }];
const RATES = { cpu: 0.0325, memory: 0.0044 };

describe('rounding and recommendation', () => {
  test('rounds up to tidy steps', () => {
    expect(roundCpu(0.013)).toBe(0.015);
    expect(roundCpu(0.123)).toBe(0.13);
    expect(roundCpu(1.21)).toBe(1.25);
    expect(roundMemory(100 * MI)).toBe(104 * MI);
    expect(roundMemory(700 * MI)).toBe(704 * MI);
    expect(roundMemory(3000 * MI)).toBe(3072 * MI);
  });
  test('adds headroom and never goes below the floor', () => {
    expect(recommendCpu(0.1)).toBe(0.13);
    expect(recommendCpu(0.001)).toBe(0.01);
    expect(recommendMemory(100 * MI)).toBe(128 * MI);
    expect(recommendMemory(1 * MI)).toBe(32 * MI);
  });
  test('verdicts', () => {
    expect(verdictFor(1, 0.1, 0.13)).toBe('over');
    expect(verdictFor(0.15, 0.1, 0.13)).toBe('ok');
    expect(verdictFor(0.1, 0.095, 0.13)).toBe('under');
    expect(verdictFor(null, 0.1, 0.13)).toBe('no-request');
    expect(verdictFor(1, null, null)).toBe('no-data');
    expect(worstVerdict(['ok', 'over', 'under', 'no-data'])).toBe('under');
    expect(worstVerdict(['ok', 'no-data'])).toBe('ok');
  });
});

describe('workloadOf', () => {
  test('maps ReplicaSet pods to their Deployment and keeps STS/DS/Job; bare pods are themselves', () => {
    expect(workloadOf(pod('web-7f9c8d-x', 'a', { kind: 'ReplicaSet', name: 'web-7f9c8d' }, []))).toEqual({ kind: 'Deployment', name: 'web' });
    expect(workloadOf(pod('kafka-0', 'a', { kind: 'StatefulSet', name: 'kafka' }, []))).toEqual({ kind: 'StatefulSet', name: 'kafka' });
    expect(workloadOf(pod('solo', 'a', null, []))).toEqual({ kind: 'Pod', name: 'solo' });
  });
});

describe('buildRightsizing', () => {
  test('groups pods by workload, averages usage per container, recommends, judges and prices the delta', () => {
    const pods = [
      pod('web-7f9c8d-a', 'shop', { kind: 'ReplicaSet', name: 'web-7f9c8d' }, [{ name: 'app', cpu: '1', memory: '1Gi', cpuLimit: '2' }, { name: 'sidecar', cpu: '50m', memory: '64Mi' }]),
      pod('web-7f9c8d-b', 'shop', { kind: 'ReplicaSet', name: 'web-7f9c8d' }, [{ name: 'app', cpu: '1', memory: '1Gi', cpuLimit: '2' }, { name: 'sidecar', cpu: '50m', memory: '64Mi' }]),
      pod('web-7f9c8d-c', 'shop', { kind: 'ReplicaSet', name: 'web-7f9c8d' }, [{ name: 'app', cpu: '1', memory: '1Gi' }], 'Pending'),
      pod('kafka-0', 'msg', { kind: 'StatefulSet', name: 'kafka' }, [{ name: 'kafka', cpu: '500m', memory: '2Gi' }]),
    ];
    const usage = new Map([
      sample('shop', 'web-7f9c8d-a', 'app', 0.1, 200 * MI),
      sample('shop', 'web-7f9c8d-b', 'app', 0.2, 300 * MI),
      sample('shop', 'web-7f9c8d-a', 'sidecar', 0.048, 50 * MI),
      sample('shop', 'web-7f9c8d-b', 'sidecar', 0.05, 50 * MI),
      sample('msg', 'kafka-0', 'kafka', 0.49, 1.9 * 1024 * MI),
    ]);
    const out = buildRightsizing(pods, usage, RATES);
    expect(out.map((w) => w.id)).toEqual(['Deployment/shop/web', 'StatefulSet/msg/kafka']);

    const web = out[0];
    expect(web.replicas).toBe(2); // the Pending pod does not count
    const app = web.containers.find((c) => c.container === 'app')!;
    expect(app.cpu_usage).toBeCloseTo(0.15);
    expect(app.memory_usage).toBe(250 * MI);
    expect(app.cpu_recommended).toBe(0.2); // 0.15 × 1.3 = 0.195 → 10m step → 0.2
    expect(app.memory_recommended).toBe(320 * MI); // 312.5Mi → 32Mi step → 320Mi
    expect(app.cpu_verdict).toBe('over');
    expect(app.memory_verdict).toBe('over');
    expect(app.cpu_limit).toBe(2);
    const sidecar = web.containers.find((c) => c.container === 'sidecar')!;
    expect(sidecar.cpu_verdict).toBe('under'); // 49m of 50m
    expect(web.verdict).toBe('under'); // worst wins
    // Deltas: app cpu (1 − 0.2) × 2 = 1.6; sidecar cpu (0.05 − recommend(0.049)=0.065) × 2 = −0.03
    expect(web.cpu_delta).toBeCloseTo(1.57);
    expect(web.memory_delta).toBe((1024 - 320) * MI * 2 + 0 /* sidecar memory ok */);

    // web nets a saving despite the under-provisioned sidecar: the app
    // container's CPU cut dwarfs the sidecar's bump.
    expect(web.saving_monthly).toBeGreaterThan(0);

    const kafka = out[1];
    expect(kafka.verdict).toBe('under');
    expect(kafka.saving_monthly).toBeLessThan(0);

    const s = summarize(out);
    expect(s.under_count).toBe(2);
    expect(s.over_count).toBe(0);
    expect(s.total_saving_monthly).toBeCloseTo(web.saving_monthly); // kafka's negative does not offset
  });

  test('without usage everything is no-data with zero saving; no requests reads no-request', () => {
    const out = buildRightsizing([pod('p', 'ns', null, [{ name: 'c' }])], new Map([sample('ns', 'p', 'c', 0.1, 100 * MI)]), RATES);
    expect(out[0].containers[0].cpu_verdict).toBe('no-request');
    const none = buildRightsizing([pod('p', 'ns', null, [{ name: 'c', cpu: '1' }])], new Map(), RATES);
    expect(none[0].verdict).toBe('no-data');
    expect(none[0].saving_monthly).toBe(0);
  });

  test('over-provisioned workloads produce a positive monthly saving', () => {
    const out = buildRightsizing(
      [pod('big-abc-1', 'ns', { kind: 'ReplicaSet', name: 'big-abc' }, [{ name: 'c', cpu: '2', memory: '4Gi' }])],
      new Map([sample('ns', 'big-abc-1', 'c', 0.1, 256 * MI)]),
      RATES,
    );
    const w = out[0];
    expect(w.verdict).toBe('over');
    expect(w.cpu_delta).toBeCloseTo(2 - 0.13);
    expect(w.memory_delta).toBe(4 * 1024 * MI - 320 * MI);
    expect(w.saving_monthly).toBeGreaterThan(40);
    expect(summarize(out).total_saving_monthly).toBeCloseTo(w.saving_monthly);
  });
});
