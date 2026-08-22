// User extensions — discovery of `<userData>/extensions/<id>/` directories.
//
// Commands:
//   - list_extensions     {} -> { dir, extensions: LoadedExtensionSource[] }
//   - open_extensions_dir {} -> null  (creates the directory and reveals it)
//
// Each extension is a directory with a manifest.json (see
// electron/k8s/extension-manifest.ts) and an ES module entry. The main
// process only reads files; the renderer evaluates the module (as a blob URL)
// and hands it the extension API. A broken manifest is reported per
// extension, never as a failure of the whole list.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { app, shell } from 'electron';

import type { HandlerCtx, HandlerMap } from '../dispatch';
import { parseManifest, type ExtensionManifest } from '../k8s/extension-manifest';

export interface LoadedExtensionSource {
  manifest: ExtensionManifest | null;
  dir: string;
  /** ES module source text; null when the manifest failed or the entry is missing. */
  source: string | null;
  error: string | null;
}

export function extensionsDir(): string {
  return path.join(app.getPath('userData'), 'extensions');
}

export function readExtensions(root: string): LoadedExtensionSource[] {
  if (!fs.existsSync(root)) return [];
  const out: LoadedExtensionSource[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = parseManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), entry.name);
      const entryPath = path.join(dir, manifest.main);
      if (!fs.existsSync(entryPath)) {
        out.push({ manifest, dir, source: null, error: `${manifest.main} not found` });
        continue;
      }
      out.push({ manifest, dir, source: fs.readFileSync(entryPath, 'utf8'), error: null });
    } catch (err) {
      out.push({ manifest: null, dir, source: null, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out.sort((a, b) => (a.manifest?.id ?? a.dir).localeCompare(b.manifest?.id ?? b.dir));
}

export function register(handlers: HandlerMap, _ctx: HandlerCtx): void {
  handlers.set('list_extensions', async () => {
    const dir = extensionsDir();
    return { dir, extensions: readExtensions(dir) };
  });
  handlers.set('open_extensions_dir', async () => {
    const dir = extensionsDir();
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return null;
  });
}
