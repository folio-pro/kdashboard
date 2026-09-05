// Main-process entry. The real app lives in ./main; this shim only turns on
// Node's on-disk compile cache BEFORE that bundle is loaded, then imports it.
//
// Why a separate entry: the main bundle is several MB of JavaScript (most of
// it @kubernetes/client-node's generated clients) that V8 parses and compiles
// on every launch. module.enableCompileCache() persists the compiled bytecode
// so later launches skip that work — but it only applies to modules loaded
// AFTER it is called, so the call cannot live inside the bundle it is meant
// to cache. The dynamic import below makes electron-vite emit ./main as its
// own chunk, which is exactly what the cache then covers.
//
// Best effort: an old Node without the API, or an unwritable cache directory,
// simply means an uncached launch. Cache entries are keyed by content, so a
// new app version never reads stale bytecode.

import { app } from 'electron';
import * as path from 'node:path';
import * as nodeModule from 'node:module';

try {
  const enable = (nodeModule as { enableCompileCache?: (dir?: string) => unknown }).enableCompileCache;
  if (typeof enable === 'function') {
    // Same directory main.ts turns into userData; stay off userData itself so
    // the settings/extension files next to it are never confused with cache.
    enable(path.join(app.getPath('appData'), 'kdashboard', 'compile-cache'));
  }
} catch {
  // Uncached launch — never fatal.
}

// Awaited on purpose: Electron holds the `ready` event until the entry
// module has finished evaluating, and main.ts's module scope (userData path,
// app name, PATH fix) must run before `ready` — un-awaited, the chunk would
// race Chromium's startup and could land after it.
await import('./main');
