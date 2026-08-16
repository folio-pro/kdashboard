// Electron main process — the Tauri `run()` equivalent.
//
// Responsibilities:
//   1. Create the main window (hidden, 1280x800, min 900x600), painted in the
//      persisted theme's background colour so the reveal has no flash.
//   2. Register ONE ipcMain.handle('k8s:invoke', dispatch) that routes every
//      renderer invoke() through the dispatcher.
//   3. Register the internal window/shell/process/updater bridge commands the
//      Tauri shims call (__window_show, __shell_open, …).
//   4. Import + register all handler modules that currently exist (the Wire
//      phase extends the marked block below).
//   5. Reveal the window when the renderer is ready, capped by a 5s safety net.
//
// There is deliberately NO splash window. A splash is a second Chromium
// renderer process spawned exactly while the main renderer is booting, so it
// competes for CPU at the worst moment. The only thing it bought us was hiding
// the pre-paint flash — and `show: false` plus a theme-correct backgroundColor
// (see THEME_CHROME) already does that for free.

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
import * as nodeOps from './handlers/node-ops';
import * as metrics from './handlers/metrics';
import * as helm from './handlers/helm';
import * as topology from './handlers/topology';
import * as cost from './handlers/cost';
import * as security from './handlers/security';
import * as crd from './handlers/crd';
import * as openapi from './handlers/openapi';
import * as logs from './handlers/logs';
import * as terminal from './handlers/terminal';
import * as debug from './handlers/debug';
import * as nodeShell from './handlers/node-shell';
import * as portforward from './handlers/portforward';
import * as watch from './handlers/watch';
import * as updater from './handlers/updater';

// ---------------------------------------------------------------------------
// Theme chrome
// ---------------------------------------------------------------------------

/**
 * Window chrome colour per theme. MUST stay in sync with the `[data-theme=…]`
 * palettes in src/app.css (--bg-primary) and their `color-scheme` grouping.
 *
 * The window is painted before the renderer has produced a single pixel, so a
 * hardcoded dark background flashes on every light theme. Reading the persisted
 * theme here means the frame starts in the right colour and the reveal is
 * seamless — which is what makes a separate splash window unnecessary.
 */
const THEME_CHROME: Record<string, { bg: string; symbol: string }> = {
  'kdashboard': { bg: '#0C0C0C', symbol: '#E5E5E5' },
  'gruvbox-dark': { bg: '#2C2521', symbol: '#E5E5E5' },
  'solarized-dark': { bg: '#003C4D', symbol: '#E5E5E5' },
  'everforest-dark': { bg: '#262C28', symbol: '#E5E5E5' },
  'dracula-dark': { bg: '#272935', symbol: '#E5E5E5' },
  'monokai-dark': { bg: '#1D1D1B', symbol: '#E5E5E5' },
  'gruvbox-light': { bg: '#F9F5EB', symbol: '#3C3836' },
  'solarized-light': { bg: '#FDF6E2', symbol: '#586E75' },
  'everforest-light': { bg: '#F2F7EE', symbol: '#5C6A72' },
  'rosepine-dawn': { bg: '#F8F3ED', symbol: '#575279' },
  'github-light': { bg: '#F5F7FA', symbol: '#1F2328' },
};

/** Chrome colours for the persisted theme, falling back to the default theme. */
function themeChrome(): { bg: string; symbol: string } {
  let mode: unknown;
  try {
    mode = appHandlers.getSettingsSync().theme_mode;
  } catch {
    // Unreadable settings must never block window creation.
  }
  return (typeof mode === 'string' ? THEME_CHROME[mode] : undefined) ?? THEME_CHROME.kdashboard;
}

const isDev = !app.isPackaged;
// electron-vite sets this to the dev-server URL during `electron-vite dev`. It
// is undefined for `electron-vite preview` and packaged builds, which load the
// built renderer from out/renderer. Presence of the URL — not isDev — decides
// dev-server vs file load (preview is unpackaged but has no dev server).
const RENDERER_URL = process.env.ELECTRON_RENDERER_URL;

let mainWindow: BrowserWindow | null = null;

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
  const chrome = themeChrome();
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
    ...(isMac
      ? {}
      : { titleBarOverlay: { color: chrome.bg, symbolColor: chrome.symbol, height: 35 } }),
    // Paint the persisted theme's background before the renderer draws, so the
    // window never flashes a colour the user did not choose.
    backgroundColor: chrome.bg,
    webPreferences: {
      // .cjs, not .mjs: sandboxed preloads must be CommonJS (see the preload
      // output config in electron.vite.config.ts).
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // The renderer runs sandboxed. electron/preload.ts only uses contextBridge
      // and ipcRenderer, both of which Electron provides to sandboxed preloads —
      // all Node work happens in main, behind the k8s:invoke dispatcher.
      sandbox: true,
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

/**
 * Show the main window. Idempotent — called from `ready-to-show`, from the
 * renderer's close_splashscreen(), and from the safety timeout.
 */
function revealMainWindow(): void {
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
    // --- reveal (genuine Tauri command, kept for the renderer's initApp) ---
    // Named for the splash window it used to close. There is no splash any
    // more, but App.svelte still calls it to say "I am ready to be seen", which
    // is a useful signal alongside ready-to-show.
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
    nodeOps, // cordon_node, drain_node
    topology, // get_namespace_topology, get_resource_topology, diagnose_resource
    cost, // get_cost_overview, get_node_costs, get_node_metrics, refresh_pricing
    metrics, // get_pod_metrics, query_prometheus_range
    helm, // list_helm_releases, get_helm_release, list_helm_release_history
    security, // get_security_overview, scan_image
    crd, // discover_crds, list_crd_resources, get_crd_counts, get_crd_conditions
    openapi, // get_openapi_schema (YAML editor autocompletion + validation)
    // --- Phase 2: streaming subsystems ---
    logs, // stream_pod_logs, stream_multi_pod_logs, stop_log_stream
    terminal, // start_terminal_exec, send_terminal_input, resize_terminal, stop_terminal_exec
    debug, // debug_pod (ephemeral debug containers)
    nodeShell, // start_node_shell, stop_node_shell
    portforward, // start_port_forward, stop_port_forward
    watch, // start_resource_watch, stop_resource_watch
    updater, // __updater_check, __updater_download (+ background update-available notice)
  ];

  return modules;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/** Create the main window and arm the reveal. Re-runs on macOS `activate` after
 * all windows were closed — everything here must be safe to repeat (unlike the
 * one-time setup in bootstrap()). */
function createWindows(): void {
  const win = createMainWindow();
  mainWindow = win;

  // Reveal THIS window, never whatever `mainWindow` happens to point at when
  // the timer fires. On macOS, closing every window and reactivating runs
  // createWindows() again, so a timer armed for the previous window would
  // otherwise show the new one before it had painted.
  let safetyTimer: ReturnType<typeof setTimeout> | undefined;
  const reveal = (): void => {
    clearTimeout(safetyTimer);
    if (win.isDestroyed() || win.isVisible()) return;
    win.show();
    win.focus();
  };

  // `ready-to-show` fires once the renderer has produced its first frame, so
  // the window is never shown mid-paint. This replaces a fixed 250ms delay
  // after did-finish-load: it is both earlier on a fast boot and safer on a
  // slow one.
  win.once('ready-to-show', reveal);

  // Safety net: a renderer that never reaches first paint must not leave the
  // user staring at no window at all.
  safetyTimer = setTimeout(reveal, 5000);
  win.once('closed', () => clearTimeout(safetyTimer));
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

  // Boot settings, served synchronously. The renderer applies the persisted
  // theme from this BEFORE mount (src/main.ts), so the first paint is already
  // correct instead of arriving one async invoke later. Registered before
  // createWindows() so it can never be missed by an early renderer.
  //
  // sendSync blocks the renderer, so this must stay a cheap in-memory read —
  // getSettingsSync() memoises after the first disk hit.
  ipcMain.on('k8s:boot-settings', (event) => {
    try {
      // Structured-clone safe: the settings file is plain JSON.
      event.returnValue = appHandlers.getSettingsSync();
    } catch {
      // Never leave the renderer blocked on a throw — it falls back to the
      // async get_settings path and its own defaults.
      event.returnValue = null;
    }
  });

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
