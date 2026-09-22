import { test, expect, describe } from 'bun:test';

import { describeInvokeError } from './errors';

// undici fetch failures: `TypeError: fetch failed` with the coded error in `cause`.
function fetchFailed(code: string): Error {
  return new TypeError('fetch failed', { cause: Object.assign(new Error('timeout'), { code }) });
}

describe('describeInvokeError network hints', () => {
  test('maps an undici body timeout to a readable hint', () => {
    const msg = describeInvokeError(fetchFailed('UND_ERR_BODY_TIMEOUT'));
    expect(msg).toContain('[UND_ERR_BODY_TIMEOUT]');
    expect(msg).toContain('stopped sending data');
  });

  test('maps an undici headers timeout to a hung-apiserver hint', () => {
    const msg = describeInvokeError(fetchFailed('UND_ERR_HEADERS_TIMEOUT'));
    expect(msg).toContain('[UND_ERR_HEADERS_TIMEOUT]');
    expect(msg).toContain('hung apiserver');
  });
});
