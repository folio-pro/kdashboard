// Unit tests for the pure context-pinning guard (bun test). The rest of the
// tool surface is covered end-to-end in integration/agent-mcp.itest.ts.

import { describe, expect, test } from 'bun:test';

import { contextGuardMessage, logMatcher, thin } from './tools';

describe('contextGuardMessage', () => {
  test('null while the pinned context is still active', () => {
    expect(contextGuardMessage('kind-a', 'kind-a')).toBeNull();
    expect(contextGuardMessage(undefined, undefined)).toBeNull();
  });

  test('refuses after a switch, naming both contexts', () => {
    const msg = contextGuardMessage('kind-a', 'kind-b');
    expect(msg).toMatch(/kind-a/);
    expect(msg).toMatch(/kind-b/);
    expect(msg).toMatch(/context changed/i);
  });

  test('refuses when the context disappears entirely', () => {
    expect(contextGuardMessage('kind-a', undefined)).toMatch(/\(none\)/);
  });
});

describe('logMatcher', () => {
  test('plain text is a case-insensitive substring match', () => {
    const m = logMatcher('Timeout');
    expect(m('connection TIMEOUT after 3s')).toBe(true);
    expect(m('all good')).toBe(false);
  });

  test('/re/ is a regex, case-insensitive unless flags say otherwise', () => {
    expect(logMatcher('/err(or)?:\\s\\d+/')('ERROR: 42')).toBe(true);
    expect(logMatcher('/^warn/')('a warn')).toBe(false);
  });

  test('an invalid regex falls back to substring', () => {
    expect(logMatcher('/[/')('a [ b')).toBe(true);
  });
});

describe('thin', () => {
  test('keeps at most max evenly spaced items', () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const out = thin(items, 30);
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out[0]).toBe(0);
    expect(thin([1, 2, 3], 30)).toEqual([1, 2, 3]);
  });
});
