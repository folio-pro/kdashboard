// Unit tests for the pure context-pinning guard (bun test). The rest of the
// tool surface is covered end-to-end in integration/agent-mcp.itest.ts.

import { describe, expect, test } from 'bun:test';

import { contextGuardMessage } from './tools';

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
