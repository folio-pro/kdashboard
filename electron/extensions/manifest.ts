// Extension manifests — pure parsing/validation of `<dir>/manifest.json`.

export interface ExtensionManifest {
  /** Unique id, `[a-z0-9][a-z0-9-]*`; used for the directory and for ids. */
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Entry module relative to the extension directory (default `index.js`). */
  main: string;
  /** The kdashboard extension API version this was written for. */
  api: number;
}

export const EXTENSION_API_VERSION = 1;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Validate a parsed manifest; throws a sentence a user can act on. */
export function parseManifest(raw: unknown, dirName: string): ExtensionManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${dirName}/manifest.json is not an object`);
  const m = raw as Record<string, unknown>;
  const id = typeof m.id === 'string' ? m.id : dirName;
  if (!ID_RE.test(id)) throw new Error(`${dirName}: id "${id}" must match ${ID_RE}`);
  if (typeof m.name !== 'string' || !m.name.trim()) throw new Error(`${dirName}: manifest needs a "name"`);
  if (typeof m.version !== 'string' || !m.version.trim()) throw new Error(`${dirName}: manifest needs a "version"`);
  const main = typeof m.main === 'string' && m.main.trim() ? m.main.trim() : 'index.js';
  if (main.includes('..') || main.startsWith('/')) throw new Error(`${dirName}: "main" must be a file inside the extension directory`);
  const api = typeof m.api === 'number' ? m.api : EXTENSION_API_VERSION;
  if (api !== EXTENSION_API_VERSION) throw new Error(`${dirName}: written for extension API ${api}; this build provides ${EXTENSION_API_VERSION}`);
  return { id, name: m.name.trim(), version: m.version.trim(), description: typeof m.description === 'string' ? m.description : undefined, main, api };
}
