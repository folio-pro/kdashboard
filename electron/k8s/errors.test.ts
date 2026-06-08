import { test, expect, describe } from 'bun:test';

import { k8sErrorMessage } from './errors';

describe('k8sErrorMessage', () => {
  test('prefers the apiserver body.message (Status object)', () => {
    expect(k8sErrorMessage({ body: { message: 'pods "x" not found' } })).toBe('pods "x" not found');
  });

  test('body.message wins over the JS Error message', () => {
    expect(k8sErrorMessage({ body: { message: 'api' }, message: 'js' })).toBe('api');
  });

  test('falls back to the JS Error message', () => {
    expect(k8sErrorMessage(new Error('boom'))).toBe('boom');
    expect(k8sErrorMessage({ message: 'plain' })).toBe('plain');
  });

  test('ignores empty body.message and empty message', () => {
    expect(k8sErrorMessage({ body: { message: '' }, message: 'fallback' })).toBe('fallback');
  });

  test('stringifies anything else', () => {
    expect(k8sErrorMessage('raw string')).toBe('raw string');
    expect(k8sErrorMessage(42)).toBe('42');
    expect(k8sErrorMessage(null)).toBe('null');
  });
});
