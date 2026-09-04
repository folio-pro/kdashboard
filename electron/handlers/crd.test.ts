import { test, expect, describe } from 'bun:test';

import { parseCrdType, CRD_TYPE_PREFIX } from './crd';

describe('parseCrdType — the renderer\'s crd:<group>/<Kind> pseudo-type', () => {
  test('splits group and Kind at the last slash', () => {
    expect(parseCrdType('crd:demo.kdash.io/Widget')).toEqual({ group: 'demo.kdash.io', kind: 'Widget' });
    expect(parseCrdType(`${CRD_TYPE_PREFIX}cert-manager.io/Certificate`)).toEqual({
      group: 'cert-manager.io',
      kind: 'Certificate',
    });
  });

  test('is undefined for built-in types and malformed pseudo-types', () => {
    expect(parseCrdType('pods')).toBeUndefined();
    expect(parseCrdType('crd:')).toBeUndefined();
    expect(parseCrdType('crd:nogroup')).toBeUndefined();
    expect(parseCrdType('crd:/Widget')).toBeUndefined();
    expect(parseCrdType('crd:demo.kdash.io/')).toBeUndefined();
  });
});
