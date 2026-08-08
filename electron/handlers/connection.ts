// Connection handler group — ports the Tauri "connection" commands to
// @kubernetes/client-node.
//
// Rust sources ported (faithful 1:1):
//   - src-tauri/src/k8s/context.rs   (list_contexts, get_current_context,
//                                      set_context, list_namespaces)
//   - src-tauri/src/k8s/client.rs    (resolve_kubeconfig_path / reset)
//   - src-tauri/src/commands/k8s_commands.rs
//       get_contexts / get_current_context / get_namespaces /
//       switch_context / check_connection
//
// Commands implemented (EXACT Tauri command strings):
//   - get_contexts        -> string[]   (context names from the kubeconfig file)
//   - get_current_context -> string     (the `current-context` field)
//   - get_namespaces      -> string[]   (namespace names via CoreV1Api)
//   - switch_context      -> null       (writes current-context to the file +
//                                        re-points the shared KubeConfig)
//   - check_connection    -> boolean    (probes the apiserver, limit=1)
//
// Wire-casing notes:
//   - The frontend calls invoke('switch_context', { context }) — the arg key is
//     `context` (see src/lib/stores/k8s.svelte.ts + src/lib/benchmark/e2e-runner.ts).
//   - All five commands return bare scalars / string arrays — no serde struct
//     wrapping in the Rust originals, so no field-casing concerns here.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { load as yamlLoad, dump as yamlDump } from 'js-yaml';

import type { HandlerCtx, HandlerMap } from '../dispatch';
import {
  getAuthorizationV1Api,
  getCoreV1Api,
  getKubeconfigPath,
  setActiveContext,
} from '../k8s/client';

// ---------------------------------------------------------------------------
// Return-type aliases — these mirror the Rust `Result<T, String>` payloads.
// The renderer consumes them via invoke<string[]> / invoke<string> /
// invoke<boolean> (grep src/lib/stores/k8s.svelte.ts + benchmark/e2e-runner.ts).
// ---------------------------------------------------------------------------

/** `get_contexts` / `get_namespaces` -> Vec<String>. */
type NameList = string[];

/** `get_current_context` -> String. */
type ContextName = string;

/** `check_connection` -> bool. */
type Connected = boolean;

// ---------------------------------------------------------------------------
// Kubeconfig file resolution — faithful port of Rust resolve_kubeconfig_path().
// Rust uses the persisted override (with ~ expansion) or ~/.kube/config.
// It deliberately ignores $KUBECONFIG for path resolution, so we do too here:
// `getKubeconfigPath()` returns the persisted override (settings) or null.
// ---------------------------------------------------------------------------

/** Expand a leading `~` to the user's home directory (mirrors expand_tilde). */
function expandTilde(p: string): string {
  if (p.startsWith('~')) {
    const home = os.homedir();
    if (home) {
      return path.join(home, p.slice(1).replace(/^\/+/, ''));
    }
  }
  return p;
}

/** Default kubeconfig location: ~/.kube/config (mirrors default_kubeconfig_path). */
function defaultKubeconfigPath(): string {
  return path.join(os.homedir() || '.', '.kube', 'config');
}

/** Resolved path of the active kubeconfig file (mirrors resolve_kubeconfig_path). */
function resolveKubeconfigPath(): string {
  const override = getKubeconfigPath();
  return override ? expandTilde(override) : defaultKubeconfigPath();
}

/** Minimal shape of the kubeconfig YAML we touch. */
interface KubeconfigYaml {
  'current-context'?: unknown;
  contexts?: Array<{ name?: unknown } | null> | unknown;
  [key: string]: unknown;
}

function readKubeconfigYaml(): KubeconfigYaml {
  const file = resolveKubeconfigPath();
  const contents = fs.readFileSync(file, 'utf8');
  const parsed = yamlLoad(contents);
  if (parsed === null || typeof parsed !== 'object') {
    // Mirror serde_yaml: an empty/scalar doc has no contexts / current-context.
    return {};
  }
  return parsed as KubeconfigYaml;
}

// ---------------------------------------------------------------------------
// list_contexts — read context names from the kubeconfig file.
// Faithful to context.rs::list_contexts: parse the YAML, pull each
// contexts[].name, skip entries without a name, default to [].
// ---------------------------------------------------------------------------
function listContexts(): NameList {
  const yaml = readKubeconfigYaml();
  const seq = yaml.contexts;
  if (!Array.isArray(seq)) {
    return [];
  }
  const names: string[] = [];
  for (const entry of seq) {
    if (entry && typeof entry === 'object') {
      const name = (entry as { name?: unknown }).name;
      if (typeof name === 'string') {
        names.push(name);
      }
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// get_current_context — read the `current-context` field from the file.
// context.rs errors with "No current-context found in kubeconfig" when absent.
// ---------------------------------------------------------------------------
function getCurrentContext(): ContextName {
  const yaml = readKubeconfigYaml();
  const current = yaml['current-context'];
  if (typeof current !== 'string') {
    throw new Error('No current-context found in kubeconfig');
  }
  return current;
}

// ---------------------------------------------------------------------------
// set_context — write `current-context` back to the kubeconfig FILE, then
// re-point the shared in-memory KubeConfig so subsequent Api calls use it.
//
// Rust context.rs::set_context writes the file and reset_client()s. We persist
// to the same file (the benchmark relies on this — it restores the original
// current-context afterwards) AND call setActiveContext() so the cached
// KubeConfig is invalidated and re-points immediately (the Electron analogue of
// reset_client()). Note: Rust does NOT validate the context exists before
// writing, but setActiveContext() throws 'Context not found: <name>' if absent —
// so we write the file first (matching Rust) and only then sync the in-memory
// context, swallowing a not-found there to keep file-write behavior identical.
// ---------------------------------------------------------------------------
function setContext(context: string): void {
  const file = resolveKubeconfigPath();
  const contents = fs.readFileSync(file, 'utf8');
  const parsed = yamlLoad(contents);
  const yaml: KubeconfigYaml =
    parsed && typeof parsed === 'object' ? (parsed as KubeconfigYaml) : {};

  yaml['current-context'] = context;

  const updated = yamlDump(yaml);
  fs.writeFileSync(file, updated, 'utf8');

  // Re-point the shared KubeConfig (analogue of reset_client()).
  setActiveContext(context);
}

// ---------------------------------------------------------------------------
// list_namespaces — namespace names via the Kubernetes API (CoreV1Api).
// context.rs::list_namespaces: Api::all + ListParams::default, project .name.
// ---------------------------------------------------------------------------
async function listNamespaces(): Promise<NameList> {
  const core = getCoreV1Api();
  const res = await core.listNamespace();
  const names = res.items
    .map((ns) => ns.metadata?.name)
    .filter((n): n is string => typeof n === 'string');
  return filterNamespacesByAccess(names);
}

/**
 * Keep only namespaces the current user can actually work in, probed with a
 * SelfSubjectAccessReview for `list pods` per namespace (the minimal verb the
 * dashboard needs everywhere). Fail-open on any review error and when the
 * filter would leave nothing — hiding real namespaces is worse than showing
 * one that later 403s.
 */
async function filterNamespacesByAccess(names: string[]): Promise<string[]> {
  if (names.length === 0) return names;
  const auth = getAuthorizationV1Api();
  const allowed = await Promise.all(
    names.map(async (namespace) => {
      try {
        const review = await auth.createSelfSubjectAccessReview({
          body: {
            spec: {
              resourceAttributes: { namespace, verb: 'list', resource: 'pods' },
            },
          },
        });
        return review.status?.allowed ? namespace : null;
      } catch {
        return namespace;
      }
    }),
  );
  const visible = allowed.filter((n): n is string => n !== null);
  return visible.length > 0 ? visible : names;
}

// ---------------------------------------------------------------------------
// check_connection — probe the apiserver with a limit=1 namespace list.
// k8s_commands.rs::check_connection: get_client() then ns list limit(1).
//   - client build failure  -> "Failed to create client: <e>"
//   - list failure          -> "Cluster unreachable: <e>"
//   - success               -> true
// ---------------------------------------------------------------------------
async function checkConnection(): Promise<Connected> {
  let core: ReturnType<typeof getCoreV1Api>;
  try {
    core = getCoreV1Api();
  } catch (e) {
    throw new Error(`Failed to create client: ${errMsg(e)}`);
  }
  try {
    await core.listNamespace({ limit: 1 });
    return true;
  } catch (e) {
    throw new Error(`Cluster unreachable: ${errMsg(e)}`);
  }
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------
export function register(handlers: HandlerMap, _ctx: HandlerCtx): void {
  handlers.set('get_contexts', async (): Promise<NameList> => listContexts());

  handlers.set(
    'get_current_context',
    async (): Promise<ContextName> => getCurrentContext(),
  );

  handlers.set('get_namespaces', async (): Promise<NameList> => listNamespaces());

  handlers.set(
    'switch_context',
    async (args: Record<string, unknown>): Promise<null> => {
      const context = args.context;
      if (typeof context !== 'string' || context.length === 0) {
        throw new Error('switch_context requires a `context` string argument');
      }
      setContext(context);
      // Rust also calls clear_k8s_version_cache() here; that cache is owned by
      // the observability handler group. Re-pointing the shared KubeConfig via
      // setActiveContext() already invalidates the connection; the version cache
      // is cleared by that group's switch hook. Return () -> null.
      return null;
    },
  );

  handlers.set('check_connection', async (): Promise<Connected> => checkConnection());
}
