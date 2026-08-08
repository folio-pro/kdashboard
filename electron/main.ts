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

import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  nativeImage,
  Menu,
  type MenuItemConstructorOptions,
} from 'electron';
import * as path from 'node:path';
import { buildDispatcher, type HandlerCtx, type HandlerModule } from './dispatch';
import { setKubeconfigPath } from './k8s/client';
import { fixPathEnv } from './path-fix';

// Handler modules — each exports register(handlers, ctx). See dispatch.ts.
import * as appHandlers from './handlers/app';
import * as connection from './handlers/connection';
import * as resources from './handlers/resources';
import * as workloadOps from './handlers/workload-ops';
import * as topology from './handlers/topology';
import * as cost from './handlers/cost';
import * as security from './handlers/security';
import * as crd from './handlers/crd';
import * as logs from './handlers/logs';
import * as terminal from './handlers/terminal';
import * as portforward from './handlers/portforward';
import * as watch from './handlers/watch';
import * as updater from './handlers/updater';

const isDev = !app.isPackaged;
// electron-vite sets this to the dev-server URL during `electron-vite dev`. It
// is undefined for `electron-vite preview` and packaged builds, which load the
// built renderer from out/renderer. Presence of the URL — not isDev — decides
// dev-server vs file load (preview is unpackaged but has no dev server).
const RENDERER_URL = process.env.ELECTRON_RENDERER_URL;

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let splashClosed = false;

// ---------------------------------------------------------------------------
// Streaming cleanup
// ---------------------------------------------------------------------------

/**
 * Stop every streaming subsystem. Called when the renderer reloads (Cmd+R) or
 * its process dies: the renderer loses all sessionIds, so any live log stream,
 * terminal, watch or port-forward would be orphaned (and forwarded local ports
 * would stay bound until app exit).
 */
function stopStreamingSubsystems(): void {
  logs.stopAllLogStreams();
  terminal.stopAllTerminalSessions();
  portforward.stopAllPortForwards();
  watch.stopAllWatches();
}

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
    // macOS: float the traffic lights, vertically centered in the 35px
    // WindowTitleBar with the standard left inset (matches VSCode).
    ...(isMac ? { trafficLightPosition: { x: 13, y: 10 } } : {}),
    // Windows/Linux have no traffic lights — overlay native window controls so
    // min/max/close stay reachable (the app draws no custom buttons).
    ...(isMac ? {} : { titleBarOverlay: { color: '#0c0c0c', symbolColor: '#e5e5e5', height: 35 } }),
    // Avoid a white flash before the renderer paints the themed bar.
    backgroundColor: '#0c0c0c',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs require('electron'); handlers run in main
    },
  });

  // Orphaned-stream cleanup: main-frame navigations (reload included; not
  // in-page ones) and renderer death invalidate every sessionId the renderer
  // held, so tear the streams down with it.
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) stopStreamingSubsystems();
  });
  win.webContents.on('render-process-gone', () => {
    stopStreamingSubsystems();
  });

  // Never navigate the app window to external content; the renderer is a local
  // SPA (dev server or bundled file).
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = RENDERER_URL ? url.startsWith(RENDERER_URL) : url.startsWith('file://');
    if (!allowed) event.preventDefault();
  });

  // No child windows: external http(s) links open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  if (RENDERER_URL) {
    void win.loadURL(RENDERER_URL);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
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

  if (RENDERER_URL) {
    void win.loadURL(`${RENDERER_URL}/splashscreen.html`);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/splashscreen.html'));
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
    security, // get_security_overview, scan_image
    crd, // discover_crds, list_crd_resources, get_crd_counts, get_crd_conditions
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

/** Create splash + main windows and arm the reveal timers. Re-runs on macOS
 * `activate` after all windows were closed — everything here must be safe to
 * repeat (unlike the one-time setup in bootstrap()). */
function createWindows(): void {
  splashClosed = false;
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

/** One-time app setup: menu, dispatcher, IPC handler, timers. Must run exactly
 * once — ipcMain.handle throws on double registration and the periodic refresh
 * would duplicate. Window (re)creation lives in createWindows(). */
function bootstrap(): void {
  buildApplicationMenu();

  // macOS dock icon. Packaged builds get the icon from the app bundle
  // (electron-builder mac.icon); in dev we load the same source icon so the
  // dock shows kdashboard's icon instead of the generic Electron one.
  if (isDev && process.platform === 'darwin' && app.dock) {
    // out/main -> repo root /build/icon.png (dev only; packaged builds get the
    // dock icon from the app bundle via electron-builder mac.icon).
    const icon = nativeImage.createFromPath(path.join(__dirname, '../../build/icon.png'));
    if (!icon.isEmpty()) app.dock.setIcon(icon);
  }

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
  ipcMain.handle('k8s:invoke', async (event, cmd: string, args: Record<string, unknown>) => {
    // Only the main frame of OUR window may drive the backend — rejects
    // iframes/child frames and any other webContents.
    if (!mainWindow || event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw new Error('k8s:invoke: rejected sender (not the main frame of the app window)');
    }
    return dispatch(cmd, args);
  });

  // Revalidate cached pricing datasets once a day in the background (mirrors
  // the Rust spawn_periodic_refresh in setup()).
  cost.startPeriodicRefresh();

  createWindows();
}

// App name drives the macOS menu-bar title + about panel. Must be set before
// the default application menu is built. (Packaged builds also get this from
// electron-builder productName -> CFBundleName.)
app.setName('Kdashboard');
// setName also moves the default userData dir ("Kdashboard"); keep the
// historical lowercase path so existing installs (case-sensitive Linux)
// don't lose their state.
app.setPath('userData', path.join(app.getPath('appData'), 'kdashboard'));

// Explicitly name the macOS About panel — otherwise it falls back to the
// running bundle (which is "Electron" in dev).
app.setAboutPanelOptions({
  applicationName: 'Kdashboard',
  applicationVersion: app.getVersion(),
});

/**
 * Build the macOS application menu so the app submenu reads "Kdashboard" (not
 * "Electron") and the standard shortcuts (Cmd+Q/C/V/W, fullscreen, devtools)
 * work in a frameless window. No-op on Windows/Linux (the default menu is fine
 * and there is no global app-name menu item there).
 */
function buildApplicationMenu(): void {
  if (process.platform !== 'darwin') return;
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'Kdashboard',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Single-instance: a second launch quits itself; the running instance restores
// and focuses its window instead. Dev builds skip the lock — parallel worktrees
// share the same userData dir, and the lock would silently quit every dev
// launch after the first.
if (app.isPackaged && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  // Adopt the login shell's PATH so GUI launches can find kubectl / trivy / grype
  // / cloud auth plugins (macOS/Linux GUI apps don't inherit it). Synchronous and
  // must run before any handler spawns a process.
  fixPathEnv();

  app.whenReady().then(bootstrap);

  app.on('window-all-closed', () => {
    // On macOS the app stays alive without windows; stop the streams so a
    // closed window doesn't keep pulling from the cluster (watch reconnect
    // loop, log streams, bound local ports).
    stopStreamingSubsystems();
    if (process.platform !== 'darwin') app.quit();
  });

  // macOS dock re-activation: recreate windows only — bootstrap() (IPC handler,
  // timers) already ran and must not run twice.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindows();
  });
}
