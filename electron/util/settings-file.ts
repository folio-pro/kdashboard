// settings.json persistence, kept free of `electron` so it is unit-testable.
//
// Writes are atomic (temp file + rename) and 0600, since the file holds the
// external MCP bearer token. A file that exists but does not parse to a JSON
// object is moved aside to `<file>.corrupt-<ms>` instead of being silently
// treated as empty — otherwise the next save would overwrite it and every
// setting would be lost without a trace.

import * as fs from 'node:fs';

import { atomicWriteSync } from './fs-atomic.js';

export type SettingsObject = Record<string, unknown>;

export interface SettingsReadResult {
  settings: SettingsObject;
  /** Set when the file existed but was unusable. `backupPath` is null if the
   *  file could not be moved aside. */
  corrupt: { backupPath: string | null } | null;
}

export function readSettingsFile(file: string, now: number = Date.now()): SettingsReadResult {
  let contents: string;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { settings: {}, corrupt: null };
    }
    return { settings: {}, corrupt: { backupPath: backUp(file, now) } };
  }
  try {
    const parsed = JSON.parse(contents) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { settings: parsed as SettingsObject, corrupt: null };
    }
  } catch {
    // fall through: corrupt
  }
  return { settings: {}, corrupt: { backupPath: backUp(file, now) } };
}

export function writeSettingsFile(file: string, settings: SettingsObject): void {
  atomicWriteSync(file, JSON.stringify(settings, null, 2), 0o600);
}

function backUp(file: string, now: number): string | null {
  const backup = `${file}.corrupt-${now}`;
  try {
    fs.renameSync(file, backup);
    return backup;
  } catch {
    return null;
  }
}
