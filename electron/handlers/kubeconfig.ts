// Kubeconfig management — import (merge) another kubeconfig into the active
// file, remove a context, and a native file picker.
//
// Commands:
//   - preview_kubeconfig        { path? | content? } -> { file, rows: PreviewRow[] }
//   - import_kubeconfig         { path? | content?, overwrite?, contexts? }
//                               -> { file, backup, contexts, clusters, users }  (MergeSection each)
//   - remove_kubeconfig_context { context } -> { file, backup, removedCluster?, removedUser? }
//   - pick_kubeconfig_file      {} -> string | null   (native open dialog)
//
// Every write backs the file up first (`<file>.kdash-backup-<timestamp>`),
// writes atomically (tmp + rename) keeping the original mode, and invalidates
// the shared KubeConfig so new contexts are usable immediately. Only
// `clusters`, `users`, `contexts` and `current-context` are ever touched.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { dump as yamlDump } from 'js-yaml';

import type { HandlerCtx, HandlerMap } from '../dispatch';
import { getActiveContextName, reloadKubeconfig } from '../k8s/client';
import {
  mergeKubeconfig,
  parseKubeconfig,
  previewMerge,
  removeContext,
  type KubeconfigDoc,
} from '../k8s/kubeconfig-merge';
import { resolveKubeconfigPath } from './connection';

function expandTilde(p: string): string {
  if (p.startsWith('~')) {
    const home = os.homedir();
    if (home) return path.join(home, p.slice(1).replace(/^\/+/, ''));
  }
  return p;
}

/** The active kubeconfig as a document; a missing file reads as empty. */
function readActive(): { file: string; doc: KubeconfigDoc; exists: boolean } {
  const file = resolveKubeconfigPath();
  if (!fs.existsSync(file)) return { file, doc: {}, exists: false };
  const text = fs.readFileSync(file, 'utf8');
  return { file, doc: text.trim() ? parseKubeconfig(text) : {}, exists: true };
}

/** The kubeconfig the user is importing: a path on disk or pasted YAML. */
function readSource(args: Record<string, unknown>): { doc: KubeconfigDoc; label: string } {
  const content = typeof args.content === 'string' ? args.content : '';
  const p = typeof args.path === 'string' ? args.path.trim() : '';
  if (content.trim()) return { doc: parseKubeconfig(content), label: 'pasted kubeconfig' };
  if (!p) throw new Error('Provide a kubeconfig file path or paste its contents');
  const file = expandTilde(p);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { doc: parseKubeconfig(text), label: file };
}

function backupAndWrite(file: string, doc: KubeconfigDoc, exists: boolean): string | null {
  let backup: string | null = null;
  let mode = 0o600;
  if (exists) {
    const stat = fs.statSync(file);
    mode = stat.mode & 0o777;
    backup = `${file}.kdash-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, backup);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const tmp = `${file}.kdash-tmp-${process.pid}`;
  fs.writeFileSync(tmp, yamlDump(doc, { lineWidth: -1, noRefs: true }), { encoding: 'utf8', mode });
  fs.renameSync(tmp, file);
  reloadKubeconfig();
  return backup;
}

function strList(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
}

export function register(handlers: HandlerMap, ctx: HandlerCtx): void {
  handlers.set('preview_kubeconfig', async (args) => {
    const { doc: source, label } = readSource(args);
    const { file, doc: target } = readActive();
    return { file, source: label, rows: previewMerge(target, source) };
  });

  handlers.set('import_kubeconfig', async (args) => {
    const { doc: source } = readSource(args);
    const { file, doc: target, exists } = readActive();
    const result = mergeKubeconfig(target, source, {
      overwrite: args.overwrite === true,
      contexts: strList(args.contexts),
    });
    const changed =
      result.contexts.added.length + result.contexts.replaced.length +
      result.clusters.added.length + result.clusters.replaced.length +
      result.users.added.length + result.users.replaced.length;
    const backup = changed > 0 ? backupAndWrite(file, result.merged, exists) : null;
    return { file, backup, contexts: result.contexts, clusters: result.clusters, users: result.users };
  });

  handlers.set('remove_kubeconfig_context', async (args) => {
    const name = typeof args.context === 'string' ? args.context : '';
    if (!name) throw new Error('remove_kubeconfig_context: missing context');
    let active: string | undefined;
    try {
      active = getActiveContextName();
    } catch {
      active = undefined;
    }
    if (active === name) throw new Error(`"${name}" is the active context — switch to another one first`);
    const { file, doc, exists } = readActive();
    const result = removeContext(doc, name);
    const backup = backupAndWrite(file, result.doc, exists);
    return { file, backup, removedCluster: result.removedCluster ?? null, removedUser: result.removedUser ?? null };
  });

  handlers.set('pick_kubeconfig_file', async () => {
    // Lazy import: this module is also loaded by the integration test setup
    // under plain Node, where `electron` is not available.
    const { dialog } = await import('electron');
    const win = ctx.mainWindow();
    const opts = {
      title: 'Import kubeconfig',
      defaultPath: path.join(os.homedir() || '.', '.kube'),
      properties: ['openFile', 'showHiddenFiles'] as Array<'openFile' | 'showHiddenFiles'>,
    };
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });
}
