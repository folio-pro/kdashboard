// App / settings / metadata / benchmark / kubectl command handlers.
//
// Commands implemented here:
//   - get_settings
//   - save_settings        (updates the kubeconfig override on change)
//   - get_app_metadata     (cached hostname / os version / k8s server version)
//   - run_kubectl          (spawns the kubectl binary; same flag blocklist)
//   - bench_config         (env-driven)
//   - write_bench_results  (path must match KDASH_BENCH_OUT)
//   - save_text_file       (native save dialog + write; log downloads)
//
// NOTE: `close_splashscreen` is owned by the internal module in
// electron/main.ts (it needs the window-reveal logic that lives there). We
// deliberately do NOT re-register it here.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { app, dialog } from 'electron';

import type { HandlerCtx, HandlerMap } from '../dispatch.js';
import { getKubeconfigPath, setKubeconfigPath, getVersionApi } from '../k8s/client.js';
import { setPrometheusUrl } from '../k8s/runtime-config.js';

// ===========================================================================
// Settings — snake_case keys, every field optional.
//
// The renderer's TS type (src/lib/types/settings.ts -> AppSettings) carries
// keys this interface does not model, `pinned_resources` among them. Because we
// persist exactly the object the renderer sends and echo it back on read, any
// extra key round-trips transparently — matching the renderer's expectations
// without us hard-coding them.
// ===========================================================================

interface ContextCustomization {
  icon?: string | null;
  label?: string | null;
  color?: string | null;
}

interface AppSettings {
  context?: string | null;
  namespace?: string | null;
  theme_mode?: string | null;
  kubeconfig_path?: string | null;
  table_density?: string | null;
  context_customizations?: Record<string, ContextCustomization> | null;
  // Extra renderer-only keys (e.g. pinned_resources) are preserved verbatim.
  [key: string]: unknown;
}

/** Path to the settings file under Electron's userData dir. */
function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

/** In-memory mirror of persisted settings. */
let settingsState: AppSettings | null = null;

/** Load settings from disk; returns {} if absent/unreadable. */
function loadSettings(): AppSettings {
  const file = settingsPath();
  if (!fs.existsSync(file)) {
    return {};
  }
  try {
    const contents = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(contents) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as AppSettings;
    }
    return {};
  } catch {
    // Tolerate a corrupt file: fall back to defaults rather than failing boot.
    return {};
  }
}

function persistSettings(settings: AppSettings): void {
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
}

/** Lazily get the current in-memory settings, hydrating from disk once.
 *  Also applies the kubeconfig override at first load. */
function currentSettings(): AppSettings {
  if (settingsState === null) {
    settingsState = loadSettings();
    const kp = settingsState.kubeconfig_path;
    if (typeof kp === 'string' && kp.trim().length > 0) {
      setKubeconfigPath(kp);
    }
    setPrometheusUrl(settingsState.prometheus_url as string | undefined);
  }
  return settingsState;
}

/**
 * Synchronous read of the persisted settings, for the boot path.
 *
 * main.ts serves these over a `sendSync` IPC channel so the renderer can apply
 * the persisted theme BEFORE its first paint. Going through the normal async
 * `get_settings` invoke costs a round-trip during startup, and until it
 * resolves the document carries no `data-theme` — a visible flash on every
 * light theme (see the 11 palettes in src/app.css).
 *
 * Reads disk at most once: currentSettings() memoises into settingsState, which
 * save_settings keeps current. Calling this before the window exists also
 * applies the kubeconfig / prometheus overrides earlier than the first invoke
 * would.
 */
export function getSettingsSync(): AppSettings {
  return currentSettings();
}

// ===========================================================================
// App metadata — hostname and os version never change; the k8s version is
// cached and cleared elsewhere on context switch. Wire shape is snake_case.
// ===========================================================================

interface AppMetadata {
  app_version: string;
  os: string;
  os_version: string;
  arch: string;
  hostname: string;
  k8s_version: string | null;
}

let cachedHostname: string | null = null;
let cachedOsVersion: string | null = null;
let cachedK8sVersion: string | null = null;
let cachedK8sVersionResolved = false;

function getHostname(): string {
  if (cachedHostname === null) {
    try {
      cachedHostname = os.hostname() || 'unknown';
    } catch {
      cachedHostname = 'unknown';
    }
  }
  return cachedHostname;
}

/** Best-effort OS version string, cached after first call (mirrors get_os_version). */
function getOsVersion(): string {
  if (cachedOsVersion !== null) {
    return cachedOsVersion;
  }
  // os.release() is the kernel/OS release across platforms — a faithful,
  // dependency-free stand-in for the sw_vers / /etc/os-release lookups.
  try {
    const release = os.release();
    cachedOsVersion = release && release.trim().length > 0 ? release.trim() : 'unknown';
  } catch {
    cachedOsVersion = 'unknown';
  }
  return cachedOsVersion;
}

/** Map Node's process.platform to the OS name reported in app metadata. */
function getOsName(): string {
  switch (process.platform) {
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    default:
      return process.platform; // 'linux', 'freebsd', etc.
  }
}

/** Map Node's process.arch to the arch name reported in app metadata. */
function getArch(): string {
  switch (process.arch) {
    case 'x64':
      return 'x86_64';
    case 'arm64':
      return 'aarch64';
    case 'ia32':
      return 'x86';
    default:
      return process.arch;
  }
}

/** K8s server version "major.minor", cached after first successful resolve.
 *  Returns null on any failure (cluster unreachable, etc.). */
async function getK8sVersionCached(): Promise<string | null> {
  if (cachedK8sVersionResolved) {
    return cachedK8sVersion;
  }
  try {
    const info = await getVersionApi().getCode();
    if (info && info.major != null && info.minor != null) {
      cachedK8sVersion = `${info.major}.${info.minor}`;
    } else {
      cachedK8sVersion = null;
    }
  } catch {
    cachedK8sVersion = null;
  }
  cachedK8sVersionResolved = true;
  return cachedK8sVersion;
}

function appVersion(): string {
  // app.getVersion() reads package.json "version".
  return app.getVersion();
}

// ===========================================================================
// Benchmark mode — env-driven.
// ===========================================================================

interface BenchConfig {
  enabled: boolean;
  iterations: number;
  warmup: number;
  context: string | null;
  namespace: string | null;
  out_path: string | null;
  resource_types: string | null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// Cumulative CPU time of a pid from /proc (Linux); null elsewhere. Electron's
// percentCPUUsage reads 0 for every process on some setups, and a delta of
// this over a window is unambiguous.
function procCpuMs(pid: number): number | null {
  if (process.platform !== 'linux') return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Fields after the ")" of the comm: state is index 0, utime 11, stime 12.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(rest[11]) + Number(rest[12]);
    return Math.round((ticks * 1000) / 100); // CLK_TCK is 100 on Linux
  } catch {
    return null;
  }
}

function parseEnvU32(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function optEnv(key: string): string | null {
  const v = process.env[key];
  return v !== undefined && v.length > 0 ? v : null;
}

// ===========================================================================
// kubectl — security blocklist + timeout semantics.
// ===========================================================================

interface KubectlResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

/** Flags that could redirect kubectl to a different cluster or read arbitrary
 *  files. */
const BLOCKED_KUBECTL_FLAGS = [
  '--kubeconfig',
  '--server',
  '--certificate-authority',
  '--client-certificate',
  '--client-key',
  '--token',
  '--as',
  '--as-group',
  '-s', // short for --server
] as const;

function validateKubectlArgs(args: string[]): void {
  for (const arg of args) {
    const lower = arg.toLowerCase();
    for (const blocked of BLOCKED_KUBECTL_FLAGS) {
      if (lower === blocked || lower.startsWith(`${blocked}=`)) {
        throw new Error(`Blocked flag for security: ${blocked}`);
      }
    }
  }
}

/** Maximum time (seconds) kubectl can run before being killed. */
const KUBECTL_TIMEOUT_SECS = 30;

function runKubectl(args: string[]): Promise<KubectlResult> {
  validateKubectlArgs(args);

  return new Promise<KubectlResult>((resolve, reject) => {
    const env = { ...process.env };
    const kp = getKubeconfigPath();
    if (kp) {
      env.KUBECONFIG = kp;
    }

    let child;
    try {
      child = spawn('kubectl', args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      reject(new Error(`Failed to run kubectl: ${(e as Error).message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(
        new Error(
          `kubectl timed out after ${KUBECTL_TIMEOUT_SECS}s. The command may be waiting for input or the cluster is unresponsive.`,
        ),
      );
    }, KUBECTL_TIMEOUT_SECS * 1000);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // ENOENT etc.
      reject(new Error(`Failed to run kubectl: ${e.message}`));
    });

    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        // null (killed by signal) maps to -1.
        exit_code: code ?? -1,
      });
    });
  });
}

// ===========================================================================
// Registration
// ===========================================================================

export function register(handlers: HandlerMap, _ctx: HandlerCtx): void {
  // --- get_settings ---
  handlers.set('get_settings', () => {
    return currentSettings();
  });

  // --- save_settings ---
  // Renderer call: invoke('save_settings', { settings: this.settings }).
  handlers.set('save_settings', (args) => {
    const incoming = args.settings;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      throw new Error('save_settings: missing or invalid settings');
    }
    const next = incoming as AppSettings;

    // When kubeconfig_path changes, push the override into the shared k8s
    // client so subsequent Api calls use the new file.
    const old = currentSettings();
    const oldPath = (old.kubeconfig_path ?? null) as string | null;
    const newPath = (next.kubeconfig_path ?? null) as string | null;
    if (oldPath !== newPath) {
      setKubeconfigPath(newPath && newPath.trim().length > 0 ? newPath : null);
      // The k8s version cache depends on the active cluster; invalidate it so
      // get_app_metadata re-resolves against the new config.
      cachedK8sVersion = null;
      cachedK8sVersionResolved = false;
    }

    setPrometheusUrl(next.prometheus_url as string | undefined);

    persistSettings(next);
    settingsState = next;
    return null;
  });

  // --- get_app_metadata ---
  handlers.set('get_app_metadata', async () => {
    const metadata: AppMetadata = {
      app_version: appVersion(),
      os: getOsName(),
      os_version: getOsVersion(),
      arch: getArch(),
      hostname: getHostname(),
      k8s_version: await getK8sVersionCached(),
    };
    return metadata;
  });

  // --- run_kubectl ---
  // Renderer passes Vec<String> args; arg key is `args`.
  handlers.set('run_kubectl', (args) => {
    const raw = args.args;
    if (!Array.isArray(raw) || !raw.every((a) => typeof a === 'string')) {
      throw new Error('run_kubectl: args must be an array of strings');
    }
    return runKubectl(raw as string[]);
  });

  // --- bench_config ---
  handlers.set('bench_config', () => {
    const config: BenchConfig = {
      enabled: process.env.KDASH_BENCH === '1',
      iterations: parseEnvU32('KDASH_BENCH_ITERS', 5),
      warmup: parseEnvU32('KDASH_BENCH_WARMUP', 1),
      context: optEnv('KDASH_BENCH_CONTEXT'),
      namespace: optEnv('KDASH_BENCH_NS'),
      out_path: optEnv('KDASH_BENCH_OUT'),
      resource_types: optEnv('KDASH_BENCH_TYPES'),
    };
    return config;
  });

  // --- bench_process_metrics ---
  // Benchmark-only: per-process CPU (percent since the previous call, so two
  // samples bracket a window) and memory, for scripts/bench/run.sh. Refused
  // outside benchmark mode.
  handlers.set('bench_process_metrics', () => {
    if (process.env.KDASH_BENCH !== '1') throw new Error('bench_process_metrics: not in benchmark mode');
    const mem = process.memoryUsage();
    return {
      uptime_ms: Math.round(process.uptime() * 1000),
      main_heap_used_mb: round1(mem.heapUsed / 1048576),
      main_rss_mb: round1(mem.rss / 1048576),
      processes: app.getAppMetrics().map((m) => ({
        type: m.type,
        pid: m.pid,
        cpu_percent: round1(m.cpu.percentCPUUsage),
        cpu_ms: procCpuMs(m.pid),
        working_set_mb: round1(m.memory.workingSetSize / 1024),
        private_mb: round1((m.memory.privateBytes ?? 0) / 1024),
      })),
    };
  });

  // --- write_bench_results ---
  // Renderer call: invoke('write_bench_results', { path: cfg.out_path, contents: json }).
  handlers.set('write_bench_results', (args) => {
    const targetPath = typeof args.path === 'string' ? args.path : '';
    const contents = typeof args.contents === 'string' ? args.contents : '';

    // Defense-in-depth: only allow writing to the harness-configured path.
    const allowed = process.env.KDASH_BENCH_OUT ?? '';
    if (allowed.length === 0 || targetPath !== allowed) {
      throw new Error('write_bench_results: path must match KDASH_BENCH_OUT');
    }
    try {
      fs.writeFileSync(targetPath, contents);
    } catch (e) {
      throw new Error(`write ${targetPath}: ${(e as Error).message}`);
    }
    return null;
  });

  // --- save_text_file ---
  // Renderer call: invoke('save_text_file', { defaultName, content }).
  // Opens the native save dialog (suggesting ~/Downloads/<defaultName>) and
  // writes `content` there. Resolves { path } once written, or null when the
  // user cancelled — a cancel is not an error the renderer should toast.
  handlers.set('save_text_file', async (args, ctx) => {
    const content = typeof args.content === 'string' ? args.content : null;
    if (content === null) {
      throw new Error('save_text_file: missing content');
    }
    // basename(): the renderer names the file, never the directory.
    const defaultName =
      typeof args.defaultName === 'string' && args.defaultName.length > 0
        ? path.basename(args.defaultName)
        : 'export.txt';

    let defaultPath = defaultName;
    try {
      defaultPath = path.join(app.getPath('downloads'), defaultName);
    } catch {
      // No downloads directory on this platform/profile — let the dialog pick.
    }

    const win = ctx.mainWindow();
    const options = { title: 'Save as', defaultPath };
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;

    try {
      await fs.promises.writeFile(result.filePath, content, 'utf8');
    } catch (e) {
      throw new Error(`write ${result.filePath}: ${(e as Error).message}`);
    }
    return { path: result.filePath };
  });
}
