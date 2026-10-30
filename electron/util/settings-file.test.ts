import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readSettingsFile, writeSettingsFile } from './settings-file';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdash-settings-'));
  file = path.join(dir, 'settings.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('writeSettingsFile', () => {
  test('round-trips through readSettingsFile', () => {
    const settings = { theme_mode: 'dark', agent_external_mcp_token: 'secret', pinned_resources: ['pods'] };
    writeSettingsFile(file, settings);
    expect(readSettingsFile(file)).toEqual({ settings, corrupt: null });
  });

  test('creates the parent directory', () => {
    const nested = path.join(dir, 'a', 'b', 'settings.json');
    writeSettingsFile(nested, { theme_mode: 'light' });
    expect(JSON.parse(fs.readFileSync(nested, 'utf8'))).toEqual({ theme_mode: 'light' });
  });

  test('replaces the file atomically and leaves no temp files behind', () => {
    fs.writeFileSync(file, '{"old":true}');
    const before = fs.statSync(file).ino;
    writeSettingsFile(file, { new: true });
    // rename-over gives the target a new inode; an in-place write would not.
    expect(fs.statSync(file).ino).not.toBe(before);
    expect(fs.readdirSync(dir)).toEqual(['settings.json']);
  });

  test.skipIf(process.platform === 'win32')('writes with mode 0600, even over a 0644 file', () => {
    fs.writeFileSync(file, '{}', { mode: 0o644 });
    writeSettingsFile(file, { agent_external_mcp_token: 'secret' });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('readSettingsFile', () => {
  test('missing file is empty settings, not corrupt', () => {
    expect(readSettingsFile(file)).toEqual({ settings: {}, corrupt: null });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test('truncated JSON is backed up, not left in place to be overwritten', () => {
    const original = '{"theme_mode":"dark","agent_external_mcp_tok';
    fs.writeFileSync(file, original);

    const result = readSettingsFile(file, 1700000000000);

    expect(result.settings).toEqual({});
    const backup = path.join(dir, 'settings.json.corrupt-1700000000000');
    expect(result.corrupt).toEqual({ backupPath: backup });
    expect(fs.readFileSync(backup, 'utf8')).toBe(original);
    expect(fs.existsSync(file)).toBe(false);

    // The next save must not clobber the backup.
    writeSettingsFile(file, { theme_mode: 'light' });
    expect(fs.readFileSync(backup, 'utf8')).toBe(original);
  });

  test('an empty file is corrupt', () => {
    fs.writeFileSync(file, '');
    const result = readSettingsFile(file, 1);
    expect(result.settings).toEqual({});
    expect(result.corrupt?.backupPath).toBe(`${file}.corrupt-1`);
  });

  test('valid JSON that is not an object is corrupt', () => {
    for (const body of ['[]', 'null', '42', '"x"']) {
      fs.writeFileSync(file, body);
      const result = readSettingsFile(file, 2);
      expect(result.settings).toEqual({});
      expect(result.corrupt?.backupPath).toBe(`${file}.corrupt-2`);
      fs.rmSync(`${file}.corrupt-2`);
    }
  });
});
