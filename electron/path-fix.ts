// PATH fix for GUI launches.
//
// On macOS (and Linux) a GUI app launched from Finder/Dock does NOT inherit the
// login shell's PATH, so bare-command spawns (kubectl, trivy, grype, cloud auth
// plugins) fail even though they work in a terminal. Faithful port of the Rust
// fix_path_env() in src-tauri/src/lib.rs: run the user's login shell once,
// capture its PATH, and adopt it into process.env.
//
// Must run BEFORE app.whenReady() / any spawn. No-op on Windows and when not
// packaged-from-GUI (a terminal launch already has the right PATH, and re-running
// is harmless/idempotent).

import { execFileSync } from 'node:child_process';

const START = '__PATH_START__';
const END = '__PATH_END__';

export function fixPathEnv(): void {
  if (process.platform === 'win32') return;

  const shell = process.env.SHELL && process.env.SHELL.length > 0 ? process.env.SHELL : '/bin/zsh';
  try {
    // `-ilc` = interactive login shell running one command, so the user's
    // profile (which exports PATH) is sourced. Markers bracket the value so we
    // can extract it from any banner/noise the shell prints.
    const out = execFileSync(shell, ['-ilc', `echo ${START}\${PATH}${END}`], {
      encoding: 'utf8',
      timeout: 5000,
    });
    const start = out.indexOf(START);
    const end = out.indexOf(END);
    if (start === -1 || end === -1) return;
    const path = out.slice(start + START.length, end);
    if (path.length > 0) {
      process.env.PATH = path;
    }
  } catch {
    // Best-effort: keep the inherited PATH if the shell probe fails.
  }
}
