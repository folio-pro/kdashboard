// Pure kubeconfig document surgery: summarize, preview a merge, merge, remove a
// context. No filesystem access here — the handler reads/writes files and
// this module is unit-tested on plain objects.

import { load as yamlLoad } from 'js-yaml';

export interface NamedEntry {
  name: string;
  [key: string]: unknown;
}

export interface KubeconfigDoc {
  apiVersion?: unknown;
  kind?: unknown;
  'current-context'?: unknown;
  clusters?: NamedEntry[] | unknown;
  users?: NamedEntry[] | unknown;
  contexts?: NamedEntry[] | unknown;
  [key: string]: unknown;
}

/** Parse YAML (or JSON — a YAML subset) into a kubeconfig doc, or throw. */
export function parseKubeconfig(text: string): KubeconfigDoc {
  let parsed: unknown;
  try {
    parsed = yamlLoad(text);
  } catch (err) {
    throw new Error(`Not valid kubeconfig YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Not a kubeconfig: expected a YAML mapping with clusters/users/contexts');
  }
  const doc = parsed as KubeconfigDoc;
  if (!Array.isArray(doc.contexts) && !Array.isArray(doc.clusters) && !Array.isArray(doc.users)) {
    throw new Error('Not a kubeconfig: no clusters, users or contexts found');
  }
  return doc;
}

function entries(list: unknown): NamedEntry[] {
  if (!Array.isArray(list)) return [];
  return list.filter((e): e is NamedEntry => !!e && typeof e === 'object' && typeof (e as NamedEntry).name === 'string');
}

function byName(list: unknown): Map<string, NamedEntry> {
  return new Map(entries(list).map((e) => [e.name, e]));
}

export interface ContextSummary {
  name: string;
  cluster: string;
  user: string;
  server?: string;
  namespace?: string;
}

/** One row per context, with the server its cluster points at. */
export function summarizeKubeconfig(doc: KubeconfigDoc): ContextSummary[] {
  const clusters = byName(doc.clusters);
  return entries(doc.contexts).map((c) => {
    const ctx = (c.context ?? {}) as Record<string, unknown>;
    const clusterName = typeof ctx.cluster === 'string' ? ctx.cluster : '';
    const cluster = clusters.get(clusterName)?.cluster as Record<string, unknown> | undefined;
    return {
      name: c.name,
      cluster: clusterName,
      user: typeof ctx.user === 'string' ? ctx.user : '',
      server: typeof cluster?.server === 'string' ? cluster.server : undefined,
      namespace: typeof ctx.namespace === 'string' ? ctx.namespace : undefined,
    };
  });
}

export type PreviewStatus = 'new' | 'identical' | 'conflict';

export interface PreviewRow extends ContextSummary {
  /** new: not in the target · identical: same context+cluster+user already
   *  there · conflict: the name exists with different contents. */
  status: PreviewStatus;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** What importing `source` into `target` would do, context by context. */
export function previewMerge(target: KubeconfigDoc, source: KubeconfigDoc): PreviewRow[] {
  const tCtx = byName(target.contexts);
  const tClusters = byName(target.clusters);
  const tUsers = byName(target.users);
  const sClusters = byName(source.clusters);
  const sUsers = byName(source.users);
  return summarizeKubeconfig(source).map((row) => {
    const existing = tCtx.get(row.name);
    if (!existing) return { ...row, status: 'new' };
    const srcCtx = byName(source.contexts).get(row.name);
    const identical =
      same(existing, srcCtx) &&
      same(tClusters.get(row.cluster), sClusters.get(row.cluster)) &&
      same(tUsers.get(row.user), sUsers.get(row.user));
    return { ...row, status: identical ? 'identical' : 'conflict' };
  });
}

export interface MergeOptions {
  /** Replace entries whose name already exists (default: keep the target's). */
  overwrite?: boolean;
  /** Only bring these contexts (and the clusters/users they need). Default: all. */
  contexts?: string[];
}

export interface MergeSection {
  added: string[];
  replaced: string[];
  skipped: string[];
}

export interface MergeResult {
  merged: KubeconfigDoc;
  contexts: MergeSection;
  clusters: MergeSection;
  users: MergeSection;
}

function mergeList(target: unknown, source: NamedEntry[], overwrite: boolean): { list: NamedEntry[]; section: MergeSection } {
  const list = entries(target).map((e) => ({ ...e }));
  const index = new Map(list.map((e, i) => [e.name, i]));
  const section: MergeSection = { added: [], replaced: [], skipped: [] };
  for (const entry of source) {
    const at = index.get(entry.name);
    if (at === undefined) {
      index.set(entry.name, list.length);
      list.push(entry);
      section.added.push(entry.name);
    } else if (overwrite && !same(list[at], entry)) {
      list[at] = entry;
      section.replaced.push(entry.name);
    } else {
      section.skipped.push(entry.name);
    }
  }
  return { list, section };
}

/**
 * Merge `source` into a copy of `target`: union by name for clusters, users and
 * contexts. Existing names win unless `overwrite`. `current-context` is left
 * alone unless the target had none. Nothing outside those four keys changes.
 */
export function mergeKubeconfig(target: KubeconfigDoc, source: KubeconfigDoc, opts: MergeOptions = {}): MergeResult {
  const overwrite = opts.overwrite ?? false;
  let srcContexts = entries(source.contexts);
  if (opts.contexts) {
    const wanted = new Set(opts.contexts);
    srcContexts = srcContexts.filter((c) => wanted.has(c.name));
  }
  // Only the clusters/users the chosen contexts reference.
  const needCluster = new Set<string>();
  const needUser = new Set<string>();
  for (const c of srcContexts) {
    const ctx = (c.context ?? {}) as Record<string, unknown>;
    if (typeof ctx.cluster === 'string') needCluster.add(ctx.cluster);
    if (typeof ctx.user === 'string') needUser.add(ctx.user);
  }
  const srcClusters = entries(source.clusters).filter((c) => !opts.contexts || needCluster.has(c.name));
  const srcUsers = entries(source.users).filter((u) => !opts.contexts || needUser.has(u.name));

  const clusters = mergeList(target.clusters, srcClusters, overwrite);
  const users = mergeList(target.users, srcUsers, overwrite);
  const contexts = mergeList(target.contexts, srcContexts, overwrite);

  const merged: KubeconfigDoc = {
    ...target,
    apiVersion: target.apiVersion ?? source.apiVersion ?? 'v1',
    kind: target.kind ?? source.kind ?? 'Config',
    clusters: clusters.list,
    users: users.list,
    contexts: contexts.list,
  };
  if (!merged['current-context'] && typeof source['current-context'] === 'string') {
    merged['current-context'] = source['current-context'];
  }
  return { merged, contexts: contexts.section, clusters: clusters.section, users: users.section };
}

export interface RemoveResult {
  doc: KubeconfigDoc;
  /** Cluster / user entries dropped because nothing else referenced them. */
  removedCluster?: string;
  removedUser?: string;
  /** True when current-context pointed at the removed context and was cleared. */
  clearedCurrent: boolean;
}

/** Remove a context, plus its cluster and user when no other context uses them. */
export function removeContext(doc: KubeconfigDoc, name: string): RemoveResult {
  const contexts = entries(doc.contexts);
  const victim = contexts.find((c) => c.name === name);
  if (!victim) throw new Error(`Context not found: ${name}`);
  const rest = contexts.filter((c) => c.name !== name);
  const ctx = (victim.context ?? {}) as Record<string, unknown>;
  const stillUsed = (key: 'cluster' | 'user', value: unknown) =>
    rest.some((c) => ((c.context ?? {}) as Record<string, unknown>)[key] === value);

  const out: KubeconfigDoc = { ...doc, contexts: rest };
  const result: RemoveResult = { doc: out, clearedCurrent: false };
  if (typeof ctx.cluster === 'string' && !stillUsed('cluster', ctx.cluster)) {
    out.clusters = entries(doc.clusters).filter((c) => c.name !== ctx.cluster);
    result.removedCluster = ctx.cluster;
  }
  if (typeof ctx.user === 'string' && !stillUsed('user', ctx.user)) {
    out.users = entries(doc.users).filter((u) => u.name !== ctx.user);
    result.removedUser = ctx.user;
  }
  if (doc['current-context'] === name) {
    delete out['current-context'];
    result.clearedCurrent = true;
  }
  return result;
}
