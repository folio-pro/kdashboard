// PATH fix for GUI launches.
//
// On macOS (and Linux) a GUI app launched from Finder/Dock does NOT inherit the
// login shell's PATH, so bare-command spawns (kubectl, trivy, grype, cloud auth
// plugins) fail even though they work in a terminal. The fix: run the user's
// login shell once, capture its PATH, and adopt it into process.env.
//
// The probe is expensive — an interactive login shell sources the whole
// profile (nvm, oh-my-zsh, brew shellenv…), routinely 0.5–2 s — so it must
// never sit on the startup path. It runs in the background while Chromium
// boots, and the PATH it produced last time is applied immediately from a
// small cache file, so spawns work from the first call. The promise it
// returns settles once a usable PATH is in place: at once on a cache hit,
// otherwise when the probe finishes (or fails — best effort, the inherited
// PATH stays). main.ts holds every renderer/MCP command until then.
//
// No-op on Windows and harmless on a terminal launch (the shell PATH is
// simply re-adopted).

import { execFile, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';

const START = '__PATH_START__';
const END = '__PATH_END__';
const PROBE_TIMEOUT_MS = 5000;
/**
 * Hard deadline past the execFile timeout. That timeout only sends SIGTERM and
 * the callback still waits for the child to exit — a shell that traps SIGTERM
 * (or a profile stuck on a prompt) would hold `pathReady`, and with it every
 * cluster command, forever.
 */
const PROBE_DEADLINE_MS = PROBE_TIMEOUT_MS + 1000;

export interface PathFixDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Run the login shell probe; resolves with its stdout ('' on failure). */
  probe: (shell: string) => Promise<string>;
  /** Last PATH the probe produced, or null. */
  readCache: () => string | null;
  writeCache: (path: string) => void;
}

/** The PATH the probe printed between its markers, or null when unusable. */
export function parseProbedPath(out: string): string | null {
  const start = out.indexOf(START);
  const end = out.indexOf(END, start + START.length);
  if (start === -1 || end === -1) return null;
  const path = out.slice(start + START.length, end);
  return path.length > 0 ? path : null;
}

/** The subset of execFile the probe needs; tests inject a fake. */
export type ProbeExec = (
  file: string,
  args: string[],
  options: { encoding: 'utf8'; timeout: number },
  callback: (err: Error | null, stdout: string) => void,
) => Pick<ChildProcess, 'kill'>;

/**
 * Run the login shell and resolve with its stdout — '' on any failure,
 * including a child that outlives the deadline (it is SIGKILLed).
 */
export function probeLoginShell(
  shell: string,
  exec: ProbeExec = execFile as unknown as ProbeExec,
  deadlineMs: number = PROBE_DEADLINE_MS,
): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (out: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(out);
    };
    // `-ilc` = interactive login shell running one command, so the user's
    // profile (which exports PATH) is sourced. Markers bracket the value so
    // it can be extracted from any banner/noise the shell prints.
    const child = exec(
      shell,
      ['-ilc', `echo ${START}\${PATH}${END}`],
      { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS },
      (err, stdout) => settle(err ? '' : stdout),
    );
    const deadline = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      settle('');
    }, deadlineMs);
  });
}

/** Real dependencies: the user's shell, and a plain-text cache file. */
export function realPathFixDeps(cacheFile: string): PathFixDeps {
  return {
    platform: process.platform,
    env: process.env,
    probe: (shell) => probeLoginShell(shell),
    readCache: () => {
      try {
        const cached = fs.readFileSync(cacheFile, 'utf8').trim();
        return cached.length > 0 ? cached : null;
      } catch {
        return null;
      }
    },
    writeCache: (path) => {
      try {
        fs.writeFileSync(cacheFile, path);
      } catch {
        // A cache that cannot be written only costs the next launch a probe.
      }
    },
  };
}

/**
 * Adopt the login shell's PATH. Resolves once PATH is usable for spawns —
 * immediately when a cached value exists, else after the probe. The probe
 * always runs to completion in the background and refreshes the cache when
 * the shell's PATH changed.
 */
export function fixPathEnv(deps: PathFixDeps): Promise<void> {
  if (deps.platform === 'win32') return Promise.resolve();

  const cached = deps.readCache();
  if (cached) deps.env.PATH = cached;

  const shell = deps.env.SHELL && deps.env.SHELL.length > 0 ? deps.env.SHELL : '/bin/zsh';
  const probed = deps
    .probe(shell)
    .then((out) => {
      const path = parseProbedPath(out);
      if (!path) return;
      deps.env.PATH = path;
      if (path !== cached) deps.writeCache(path);
    })
    .catch(() => {
      // Best-effort: keep whatever PATH is in place.
    });

  return cached ? Promise.resolve() : probed;
}
