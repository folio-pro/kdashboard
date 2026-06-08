// Electron main process — the Tauri `run()` equivalent.
//
// Responsibilities:
//   1. Create the main window (hidden, 1280x800, min 900x600) + a frameless
//      centered splash (400x300) loading /splashscreen.html.
//   2. Register ONE ipcMain.handle('k8s:invoke', dispatch) that routes every
//      renderer invoke() through the dispatcher.
//   3. Register the internal window/shell/process/updater bridge commands the
//      Tauri shims call (__window_show, __shell_open, …).
//   4. Import + register all handler modules that currently exist (the Wire
//      phase extends the marked block below).
//   5. After ~5s (or when the renderer signals ready) show main + close splash.

import { app, BrowserWindow, ipcMain, shell, nativeImage } from 'electron';
import * as path from 'node:path';
import { buildDispatcher, type HandlerCtx, type HandlerModule } from './dispatch';
import { setKubeconfigPath } from './k8s/client';

// Handler modules — each exports register(handlers, ctx). See dispatch.ts.
import * as appHandlers from './handlers/app';
import * as connection from './handlers/connection';
import * as resources from './handlers/resources';
import * as workloadOps from './handlers/workload-ops';
import * as topology from './handlers/topology';
import * as cost from './handlers/cost';
import * as securityCrd from './handlers/security-crd';
import * as logs from './handlers/logs';
import * as terminal from './handlers/terminal';
import * as portforward from './handlers/portforward';
import * as watch from './handlers/watch';
import * as updater from './handlers/updater';

const isDev = !app.isPackaged;
const DEV_URL = 'http://localhost:1420';

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let splashClosed = false;

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function createMainWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin';
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false, // mirrors tauri.conf.json `visible: false`
    title: '',
    // VSCode-style custom title bar: hide the native chrome so the in-app
    // TitleBar.svelte (bg-[var(--bg-primary)]) becomes the visible top bar and
    // tracks the active theme. The web content fills the whole window.
    titleBarStyle: 'hidden',
    // macOS: float the traffic lights, vertically centered in the 36px WindowTitleBar.
    ...(isMac ? { trafficLightPosition: { x: 13, y: 11 } } : {}),
    // Windows/Linux have no traffic lights — overlay native window controls so
    // min/max/close stay reachable (the app draws no custom buttons).
    ...(isMac ? {} : { titleBarOverlay: { color: '#0c0c0c', symbolColor: '#e5e5e5', height: 36 } }),
    // Avoid a white flash before the renderer paints the themed bar.
    backgroundColor: '#0c0c0c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs require('electron'); handlers run in main
    },
  });

  if (isDev) {
    void win.loadURL(DEV_URL);
  } else {
    void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  win.on('closed', () => {
    mainWindow = null;
  });

  return win;
}

function createSplashWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 400,
    height: 300,
    frame: false, // decorations: false
    resizable: false,
    center: true,
    title: '',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    void win.loadURL(`${DEV_URL}/splashscreen.html`);
  } else {
    void win.loadFile(path.join(__dirname, '..', 'dist', 'splashscreen.html'));
  }

  win.on('closed', () => {
    splashWindow = null;
  });

  return win;
}

/** Show main + close splash. Idempotent — safe to call from timeout and signal. */
function revealMainWindow(): void {
  if (splashWindow && !splashClosed) {
    splashClosed = true;
    splashWindow.close();
  }
  if (mainWindow && !mainWindow.isVisible()) {
    mainWindow.show();
    mainWindow.focus();
  }
}

// ---------------------------------------------------------------------------
// Dispatcher context + internal bridge commands
// ---------------------------------------------------------------------------

const ctx: HandlerCtx = {
  emit(channel: string, payload: unknown): void {
    mainWindow?.webContents.send(channel, payload);
  },
  mainWindow(): BrowserWindow | null {
    return mainWindow;
  },
};

/**
 * Internal commands backing the Tauri API shims (window/shell/process/updater)
 * and the splash. These are NOT real Tauri commands; they are an
 * implementation detail of the shim layer, prefixed with `__` (except
 * close_splashscreen, which is a genuine Tauri command the frontend calls).
 */
const internalModule: HandlerModule = {
  register(handlers): void {
    // --- splash (genuine Tauri command) ---
    handlers.set('close_splashscreen', () => {
      revealMainWindow();
      return null;
    });

    // --- window (tauri-window shim) ---
    handlers.set('__window_show', () => {
      revealMainWindow();
      return null;
    });
    handlers.set('__window_hide', () => {
      mainWindow?.hide();
      return null;
    });
    handlers.set('__window_set_badge_count', (args) => {
      const count = typeof args.count === 'number' ? args.count : 0;
      // macOS dock badge / Linux Unity launcher; no-op on Windows.
      app.setBadgeCount(count > 0 ? count : 0);
      return null;
    });

    // --- shell (tauri-shell shim, via preload.openExternal) ---
    handlers.set('__shell_open', async (args) => {
      const url = String(args.url ?? '');
      if (!url) throw new Error('open: missing url');
      await shell.openExternal(url);
      return null;
    });

    // --- process (tauri-process shim) ---
    handlers.set('__process_exit', (args) => {
      const code = typeof args.code === 'number' ? args.code : 0;
      app.exit(code);
      return null;
    });
    handlers.set('__process_relaunch', () => {
      app.relaunch();
      app.exit(0);
      return null;
    });

    // --- updater (tauri-updater shim) ---
    // __updater_check / __updater_download are owned by the updater handler
    // module (electron/handlers/updater.ts), registered in buildHandlerModules.
  },
};

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

function buildHandlerModules(): HandlerModule[] {
  // ===========================================================================
  // WIRE PHASE: every ported handler module is registered here. Each exports
  // `register(handlers, ctx)`. The internalModule (window/shell/process/updater
  // bridge + close_splashscreen) is registered first; the dispatcher then layers
  // the phase-2 streaming stubs (see STUBBED_PHASE2_COMMANDS in dispatch.ts) for
  // any command a real module hasn't claimed.
  // ===========================================================================
  const modules: HandlerModule[] = [
    internalModule,
    appHandlers, // get_settings, save_settings, get_app_metadata, run_kubectl, bench_config, write_bench_results
    connection, // get_contexts, get_current_context, get_namespaces, switch_context, check_connection
    resources, // list_resources, list_pods_by_selector, get_resource_counts, get_resource_yaml, get_resource, get_events, get_resource_events
    workloadOps, // apply_yaml, delete_resource, scale_workload, restart_workload, rollback_deployment, list_deployment_revisions
    topology, // get_namespace_topology, get_resource_topology, diagnose_resource
    cost, // get_cost_overview, get_node_costs, get_node_metrics, refresh_pricing
    securityCrd, // get_security_overview, scan_image, discover_crds, list_crd_resources, get_crd_counts, get_crd_conditions
    // --- Phase 2: streaming subsystems ---
    logs, // stream_pod_logs, stream_multi_pod_logs, stop_log_stream
    terminal, // start_terminal_exec, send_terminal_input, resize_terminal, stop_terminal_exec
    portforward, // start_port_forward, stop_port_forward
    watch, // start_resource_watch, stop_resource_watch
    updater, // __updater_check, __updater_download (+ background update-available notice)
  ];

  return modules;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function bootstrap(): void {
  // Honor a kubeconfig path override persisted in settings, if present.
  // The settings handler (Port phase) is the source of truth; this is a
  // best-effort early hint and a no-op until that handler exists.
  try {
    const override = process.env.KDASH_KUBECONFIG;
    if (override) setKubeconfigPath(override);
  } catch {
    // ignore — settings handler will set the real value
  }

  const { dispatch } = buildDispatcher(buildHandlerModules(), ctx);

  // ONE channel for every renderer invoke(). Errors propagate as rejected
  // promises in the renderer (the shim leaves them unwrapped).
  ipcMain.handle('k8s:invoke', async (_e, cmd: string, args: Record<string, unknown>) => {
    return dispatch(cmd, args);
  });

  splashWindow = createSplashWindow();
  mainWindow = createMainWindow();

  // Reveal once the renderer's DOM is ready, capped by a 5s safety timeout
  // (matches the Rust splash force-close behaviour).
  mainWindow.webContents.once('did-finish-load', () => {
    // Renderer also calls close_splashscreen() from initApp(); this is a
    // fallback so we never strand the splash if that call is skipped.
    setTimeout(revealMainWindow, 250);
  });
  setTimeout(revealMainWindow, 5000);
}

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) bootstrap();
});

// Suppress unused-import warning for nativeImage (reserved for future dock icon
// work); reference it so strict/noUnusedLocals stays happy if enabled.
void nativeImage;
