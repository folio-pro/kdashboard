// Shared harness for the K8s integration suite.
//
// The suite runs under node:test via tsx (`bun run test:integration`) — NOT
// under bun — because the backend's apiserver TLS bridge uses undici's global
// dispatcher, which bun's fetch ignores. Electron's runtime is Node, so Node
// is also the faithful environment.
//
// It runs only when KDASH_TEST_CONTEXT is set (in CI: a Kind cluster seeded
// from fixtures/seed.yaml); without it every test is skipped.

import { buildDispatcher, type HandlerCtx } from '../dispatch';
import * as agent from '../agent/handlers';
import * as connection from '../handlers/connection';
import * as resources from '../handlers/resources';
import * as workloadOps from '../handlers/workload-ops';
import * as nodeOps from '../handlers/node-ops';
import * as metrics from '../handlers/metrics';
import * as helm from '../handlers/helm';
import * as topology from '../handlers/topology';
import * as security from '../handlers/security';
import * as openapi from '../handlers/openapi';
import { setActiveContext } from '../k8s/client';

export const TEST_CONTEXT = process.env.KDASH_TEST_CONTEXT;
export const TEST_NAMESPACE = process.env.KDASH_TEST_NAMESPACE ?? 'kdash-test';
export const enabled = Boolean(TEST_CONTEXT);

/** Events the handlers emitted during the run, for assertions on progress. */
export const emitted: Array<{ channel: string; payload: unknown }> = [];

const ctx: HandlerCtx = {
  emit(channel, payload) {
    emitted.push({ channel, payload });
  },
  mainWindow: () => null,
};

let dispatcher: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;

/** Invoke a backend command exactly as the renderer would. */
export function dispatch<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!dispatcher) {
    setActiveContext(TEST_CONTEXT as string);
    const built = buildDispatcher(
      [connection, resources, workloadOps, nodeOps, metrics, helm, topology, security, openapi, agent],
      ctx,
    );
    dispatcher = (c, a) => built.dispatch(c, a);
  }
  return dispatcher(cmd, args) as Promise<T>;
}

/** Poll `fn` until it returns truthy or the timeout elapses. */
export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  { timeoutMs = 120_000, intervalMs = 2_000, label = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${label}` +
      (lastErr ? ` (last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)})` : ''),
  );
}
