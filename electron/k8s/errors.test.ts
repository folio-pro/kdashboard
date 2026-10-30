import { test, expect, describe } from 'bun:test';
import { ApiException } from '@kubernetes/client-node';

import { k8sErrorMessage, k8sStatusCode } from './errors';

const HEADERS = {
  'audit-id': 'b3c1a2d4-secret-audit',
  'content-type': 'application/json',
  'x-kubernetes-pf-flowschema-uid': 'flowschema-uid-123',
};

function statusBody(code: number, reason: string, message: string): string {
  return JSON.stringify({ kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Failure', message, reason, code });
}

/** Built exactly the way client-node 1.4's generated APIs throw: the body is the raw response text. */
function apiException(code: number, body: unknown, headers: Record<string, string> = HEADERS) {
  return new ApiException(code, 'Unknown API Status Code!', body, headers);
}

function expectNoLeak(msg: string) {
  expect(msg).not.toContain('HTTP-Code');
  expect(msg).not.toContain('Headers');
  expect(msg).not.toContain('audit-id');
  expect(msg).not.toContain('b3c1a2d4-secret-audit');
  expect(msg).not.toContain('flowschema-uid-123');
}

describe('k8sErrorMessage', () => {
  test('returns Status.message from a real ApiException with a string body', () => {
    const msg = 'pods "web-1" is forbidden: User "dev" cannot delete resource "pods" in API group "" in the namespace "default"';
    const out = k8sErrorMessage(apiException(403, statusBody(403, 'Forbidden', msg)));
    expect(out).toBe(msg);
    expectNoLeak(out);
  });

  test('404 Status body yields the apiserver "not found" message', () => {
    const out = k8sErrorMessage(apiException(404, statusBody(404, 'NotFound', 'deployments.apps "web" not found')));
    expect(out).toBe('deployments.apps "web" not found');
  });

  test('non-JSON string body (proxy HTML page) yields a short status-code message', () => {
    const html = '<html><head><title>502 Bad Gateway</title></head><body><center>nginx</center></body></html>';
    const out = k8sErrorMessage(apiException(502, html));
    expect(out).toBe('502 Bad Gateway');
    expectNoLeak(out);
    expect(out).not.toContain('<html>');
  });

  test('JSON body that is not a Status falls back to the status code', () => {
    const out = k8sErrorMessage(apiException(500, JSON.stringify({ error: 'x' })));
    expect(out).toBe('500 Internal Server Error');
  });

  test('401 thrown with an undefined body yields the status code, not the dump', () => {
    const out = k8sErrorMessage(apiException(401, undefined));
    expect(out).toBe('401 Unauthorized');
    expectNoLeak(out);
  });

  test('still accepts an already-parsed Status object body', () => {
    expect(k8sErrorMessage(apiException(409, { kind: 'Status', message: 'already exists' }))).toBe('already exists');
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

describe('k8sStatusCode', () => {
  test('reads the ApiException code', () => {
    expect(k8sStatusCode(apiException(404, statusBody(404, 'NotFound', 'x')))).toBe(404);
  });

  test('reads statusCode (older client shapes)', () => {
    expect(k8sStatusCode({ statusCode: 429 })).toBe(429);
  });

  test('ignores string codes (network errors like ECONNREFUSED) and non-objects', () => {
    expect(k8sStatusCode({ code: 'ECONNREFUSED' })).toBeUndefined();
    expect(k8sStatusCode(new Error('x'))).toBeUndefined();
    expect(k8sStatusCode(null)).toBeUndefined();
  });
});
