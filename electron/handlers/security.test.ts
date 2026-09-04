import { describe, expect, test } from 'bun:test';

import { summarizePods, type ImageScanResult } from './security';

const zero = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };

function scanned(image: string, vulns: Partial<typeof zero> = {}): ImageScanResult {
  return { image, vulns: { ...zero, ...vulns }, scanned_at: 't', status: 'scanned' };
}

function failed(image: string): ImageScanResult {
  return { image, vulns: { ...zero }, scanned_at: 't', status: 'failed', error: 'trivy scan failed' };
}

describe('summarizePods — scanned vs not scanned', () => {
  test('an image with no result is listed as unscanned, not as clean', () => {
    const out = summarizePods([['web', 'shop', ['nginx:1', 'sidecar:2']]], new Map());
    expect(out.pods[0].images).toEqual([]);
    expect(out.pods[0].unscanned_images).toEqual(['nginx:1', 'sidecar:2']);
    expect(out.total_images_scanned).toBe(0);
  });

  test('a failed scan keeps its status and does not count as scanned', () => {
    const results = new Map<string, ImageScanResult>([
      ['nginx:1', scanned('nginx:1', { high: 2 })],
      ['sidecar:2', failed('sidecar:2')],
    ]);
    const out = summarizePods([['web', 'shop', ['nginx:1', 'sidecar:2']]], results);
    const pod = out.pods[0];
    expect(pod.images.map((i) => i.status)).toEqual(['scanned', 'failed']);
    expect(pod.unscanned_images).toEqual([]);
    expect(pod.total_vulns.high).toBe(2);
    expect(pod.compliant).toBe(false);
    expect(out.total_images_scanned).toBe(1);
  });

  test('non-compliant pods sort first and totals fold across pods', () => {
    const results = new Map<string, ImageScanResult>([
      ['a', scanned('a', { critical: 1 })],
      ['b', scanned('b', { low: 3 })],
    ]);
    const out = summarizePods(
      [
        ['clean', 'ns', ['b']],
        ['bad', 'ns', ['a', 'b']],
      ],
      results,
    );
    expect(out.pods.map((p) => p.name)).toEqual(['bad', 'clean']);
    expect(out.compliant_pods).toBe(1);
    expect(out.non_compliant_pods).toBe(1);
    expect(out.total_vulns).toEqual({ ...zero, critical: 1, low: 6 });
    expect(out.total_images_scanned).toBe(2);
  });
});
