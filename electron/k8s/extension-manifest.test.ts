import { describe, expect, test } from 'bun:test';

import { EXTENSION_API_VERSION, parseManifest } from './extension-manifest';

describe('parseManifest', () => {
  test('fills defaults and keeps fields', () => {
    expect(parseManifest({ name: 'Audit', version: '1.0.0' }, 'audit-log')).toEqual({ id: 'audit-log', name: 'Audit', version: '1.0.0', description: undefined, main: 'index.js', api: EXTENSION_API_VERSION });
    expect(parseManifest({ id: 'x', name: 'X', version: '2', main: 'dist/x.js', description: 'd' }, 'dir').main).toBe('dist/x.js');
  });
  test('rejects bad ids, missing fields, escapes and other api versions', () => {
    expect(() => parseManifest({ id: 'Bad Id', name: 'n', version: '1' }, 'd')).toThrow(/must match/);
    expect(() => parseManifest({ version: '1' }, 'd')).toThrow(/needs a "name"/);
    expect(() => parseManifest({ name: 'n' }, 'd')).toThrow(/needs a "version"/);
    expect(() => parseManifest({ name: 'n', version: '1', main: '../x.js' }, 'd')).toThrow(/inside the extension directory/);
    expect(() => parseManifest({ name: 'n', version: '1', api: 99 }, 'd')).toThrow(/extension API 99/);
    expect(() => parseManifest('nope', 'd')).toThrow(/not an object/);
  });
});
