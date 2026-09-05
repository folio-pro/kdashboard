import { describe, expect, test } from 'bun:test';

import { fixPathEnv, parseProbedPath, probeLoginShell, type PathFixDeps, type ProbeExec } from './path-fix';

const PROBE_OK = 'banner\n__PATH_START__/opt/homebrew/bin:/usr/bin__PATH_END__\n';

function deps(overrides: Partial<PathFixDeps> = {}): PathFixDeps & { written: string[] } {
  const written: string[] = [];
  return {
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' },
    probe: async () => PROBE_OK,
    readCache: () => null,
    writeCache: (p) => {
      written.push(p);
    },
    written,
    ...overrides,
  };
}

describe('parseProbedPath', () => {
  test('extracts the PATH between the markers, ignoring shell noise', () => {
    expect(parseProbedPath(PROBE_OK)).toBe('/opt/homebrew/bin:/usr/bin');
  });

  test('is null without markers or with an empty PATH', () => {
    expect(parseProbedPath('nothing here')).toBeNull();
    expect(parseProbedPath('__PATH_START____PATH_END__')).toBeNull();
  });
});

describe('fixPathEnv', () => {
  test('no cache: resolves after the probe, with its PATH adopted and cached', async () => {
    const d = deps();
    await fixPathEnv(d);
    expect(d.env.PATH).toBe('/opt/homebrew/bin:/usr/bin');
    expect(d.written).toEqual(['/opt/homebrew/bin:/usr/bin']);
  });

  test('cache hit: PATH is usable before the probe finishes', async () => {
    let finish: (out: string) => void = () => {};
    const d = deps({
      readCache: () => '/cached/bin:/usr/bin',
      probe: () => new Promise((r) => (finish = r)),
    });
    const ready = fixPathEnv(d);
    expect(d.env.PATH).toBe('/cached/bin:/usr/bin');
    let settled = false;
    void ready.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(true);
    // The probe still refreshes PATH and the cache when the shell changed it.
    finish(PROBE_OK);
    await new Promise((r) => setTimeout(r, 0));
    expect(d.env.PATH).toBe('/opt/homebrew/bin:/usr/bin');
    expect(d.written).toEqual(['/opt/homebrew/bin:/usr/bin']);
  });

  test('cache hit that matches the probe is not rewritten', async () => {
    const d = deps({ readCache: () => '/opt/homebrew/bin:/usr/bin' });
    await fixPathEnv(d);
    await new Promise((r) => setTimeout(r, 0));
    expect(d.written).toEqual([]);
  });

  test('a failed or empty probe keeps the PATH already in place', async () => {
    const d = deps({ probe: async () => '' });
    await fixPathEnv(d);
    expect(d.env.PATH).toBe('/usr/bin:/bin');
    expect(d.written).toEqual([]);
    const rejected = deps({ probe: () => Promise.reject(new Error('spawn failed')) });
    await fixPathEnv(rejected);
    expect(rejected.env.PATH).toBe('/usr/bin:/bin');
  });

  test('probes $SHELL, falling back to /bin/zsh', async () => {
    const shells: string[] = [];
    const d = deps({ probe: async (s) => (shells.push(s), PROBE_OK) });
    await fixPathEnv(d);
    d.env.SHELL = '';
    await fixPathEnv(d);
    expect(shells).toEqual(['/bin/zsh', '/bin/zsh']);
    const fish = deps({ env: { PATH: '', SHELL: '/opt/homebrew/bin/fish' }, probe: async (s) => (shells.push(s), PROBE_OK) });
    await fixPathEnv(fish);
    expect(shells[2]).toBe('/opt/homebrew/bin/fish');
  });

  test('windows is a no-op', async () => {
    let probed = false;
    const d = deps({ platform: 'win32', probe: async () => ((probed = true), PROBE_OK) });
    await fixPathEnv(d);
    expect(probed).toBe(false);
    expect(d.env.PATH).toBe('/usr/bin:/bin');
  });
});

describe('probeLoginShell', () => {
  test('resolves with the shell output when the child exits', async () => {
    const exec: ProbeExec = (_file, _args, _opts, cb) => {
      setTimeout(() => cb(null, PROBE_OK), 0);
      return { kill: () => true };
    };
    expect(await probeLoginShell('/bin/zsh', exec, 1000)).toBe(PROBE_OK);
  });

  test('a child that never exits is killed at the deadline and yields an empty probe', async () => {
    const signals: string[] = [];
    // Never calls back: a shell that traps SIGTERM (execFile's timeout signal).
    const exec: ProbeExec = () => ({ kill: (sig) => (signals.push(String(sig)), true) });
    const t0 = Date.now();
    expect(await probeLoginShell('/bin/zsh', exec, 20)).toBe('');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
    expect(signals).toEqual(['SIGKILL']);
  });

  test('a late callback after the deadline is ignored', async () => {
    let late: ((err: Error | null, out: string) => void) | undefined;
    const exec: ProbeExec = (_f, _a, _o, cb) => ((late = cb), { kill: () => true });
    expect(await probeLoginShell('/bin/zsh', exec, 10)).toBe('');
    late?.(null, PROBE_OK); // must not throw or resolve twice
  });
});
