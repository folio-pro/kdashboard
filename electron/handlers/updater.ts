// Updater subsystem — Electron port of src-tauri/src/update.rs + the Tauri
// updater plugin, backed by electron-updater's `autoUpdater`.
//
// Renderer contract (DO NOT BREAK), from
// src/lib/components/common/UpdateBanner.svelte + src/lib/types/settings.ts:
//   - `check()` (tauri-updater shim) -> __updater_check returns either:
//       * null                              when no update is available, OR
//       * { version, body, date }           (UpdateInfo) when one is.
//     The UI reads `.version`; the shim wraps the JSON in an Update handle
//     whose `downloadAndInstall(onEvent)` drives __updater_download below.
//   - Background check emits the `update-available` event with the SAME
//     UpdateInfo shape { version, body, date } (Rust emitted exactly this).
//   - `relaunch()` is handled separately by __process_relaunch in main.ts.
//
// This is the lowest-priority subsystem: in a dev run electron-updater is
// usually unconfigured (no app-update.yml / dev-app-update.yml), and merely
// *touching* `require('electron-updater').autoUpdater` throws because it reads
// app.getVersion() during construction. Everything here is therefore wrapped
// best-effort: any failure resolves to the idle "no update" shape instead of
// crashing. Correctness of the no-update/idle path matters most.

import type { HandlerCtx, HandlerMap } from '../dispatch';

/**
 * UpdateInfo as the renderer expects it (src/lib/types/settings.ts). `body` and
 * `date` are nullable; `version` is always a string.
 */
interface UpdateInfo {
  version: string;
  body: string | null;
  date: string | null;
}

/**
 * Download-lifecycle event pushed to the renderer over UPDATER_DOWNLOAD_CHANNEL.
 * Mirrors the Tauri updater's Started/Progress/Finished union that the
 * tauri-updater shim re-emits to UpdateBanner.svelte:
 *   - Started:  { event: 'Started',  data: { contentLength } }
 *   - Progress: { event: 'Progress', data: { chunkLength } }
 *   - Finished: { event: 'Finished' }
 *   - Error:    { event: 'Error',    data: { message } }   (shim rejects on this)
 */
type DownloadEventPayload =
  | { event: 'Started'; data: { contentLength: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' }
  | { event: 'Error'; data: { message: string } };

/** Channel the renderer listens on for the background "an update exists" notice. */
const UPDATE_AVAILABLE_CHANNEL = 'update-available';
/** Channel the shim's synthesized downloadAndInstall() consumes. */
const UPDATER_DOWNLOAD_CHANNEL = 'updater-download-event';

/**
 * Shape of the bits of electron-updater's `autoUpdater` we use. Declared loosely
 * because the module is lazy-required (see getAutoUpdater) to avoid importing it
 * at module load — construction throws outside a real Electron app context.
 */
interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, cb: (...args: unknown[]) => void): unknown;
  removeAllListeners(event?: string): void;
  checkForUpdates(): Promise<{ updateInfo?: ElectronUpdateInfo } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

/** Subset of electron-updater's UpdateInfo (builder-util-runtime) we read. */
interface ElectronUpdateInfo {
  version: string;
  releaseName?: string | null;
  releaseNotes?: string | Array<{ version: string; note: string | null }> | null;
  releaseDate?: string;
}

/** electron-updater's ProgressInfo (builder-util-runtime ProgressCallbackTransform). */
interface ProgressInfo {
  total: number;
  delta: number;
  transferred: number;
  percent: number;
  bytesPerSecond: number;
}

// --- module state ----------------------------------------------------------

/** Cached autoUpdater handle. `null` = not yet resolved; `false` = unavailable. */
let autoUpdaterCache: AutoUpdaterLike | null | false = null;
/** True while a download is in flight, to guard against double-start. */
let downloading = false;
/** True once we've checked at least once (so we don't re-emit on every check). */
let backgroundNotified = false;

/**
 * Lazy-require electron-updater's autoUpdater. Returns the handle, or `false`
 * if it can't be constructed (not running under Electron, missing config, …).
 * Caches the result so repeated checks don't re-pay the cost or re-log.
 */
function getAutoUpdater(): AutoUpdaterLike | false {
  if (autoUpdaterCache !== null) return autoUpdaterCache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('electron-updater') as { autoUpdater: AutoUpdaterLike };
    const au = mod.autoUpdater;
    // Be a manual-update UX: we never auto-download or auto-install silently;
    // the user clicks "Update now" -> downloadAndInstall -> __updater_download.
    au.autoDownload = false;
    au.autoInstallOnAppQuit = true;
    autoUpdaterCache = au;
    return au;
  } catch (err) {
    // Dev run / unconfigured: degrade to the idle path, don't crash startup.
    console.warn('[updater] electron-updater unavailable, updates disabled:', errMsg(err));
    autoUpdaterCache = false;
    return false;
  }
}

/** Normalize electron-updater's releaseNotes (string | list | null) to a string|null. */
function notesToBody(notes: ElectronUpdateInfo['releaseNotes']): string | null {
  if (notes == null) return null;
  if (typeof notes === 'string') return notes;
  // fullChangelog list form: join the individual notes.
  return notes
    .map((n) => n.note ?? '')
    .filter(Boolean)
    .join('\n\n') || null;
}

/** Map electron-updater UpdateInfo to the renderer's UpdateInfo shape. */
function toRendererInfo(info: ElectronUpdateInfo): UpdateInfo {
  return {
    version: info.version,
    body: notesToBody(info.releaseNotes),
    date: info.releaseDate ?? null,
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Run a check against the configured GitHub releases feed (folio-pro/kdashboard
 * — electron-builder reads this from the packaged app-update.yml). Returns the
 * renderer UpdateInfo if a newer version exists, else null. Best-effort: any
 * failure (no config in dev, network error, already latest) -> null.
 */
async function runCheck(): Promise<UpdateInfo | null> {
  const au = getAutoUpdater();
  if (!au) return null;
  try {
    const result = await au.checkForUpdates();
    const info = result?.updateInfo;
    if (!info || !info.version) return null;
    return toRendererInfo(info);
  } catch (err) {
    // Most common in dev: "No published versions" / missing app-update.yml.
    console.warn('[updater] check failed:', errMsg(err));
    return null;
  }
}

/**
 * Background notifier — the port of Rust `check_and_notify`. Waits a few seconds
 * so it never blocks startup, runs one check, and emits `update-available` with
 * { version, body, date } if an update exists. Idempotent across the process.
 */
export function checkAndNotify(ctx: HandlerCtx): void {
  if (backgroundNotified) return;
  backgroundNotified = true;
  setTimeout(() => {
    void runCheck()
      .then((info) => {
        if (info) ctx.emit(UPDATE_AVAILABLE_CHANNEL, info);
      })
      .catch((err) => {
        console.warn('[updater] background notify failed:', errMsg(err));
      });
  }, 3000); // mirrors the Rust 3s settle delay
}

/**
 * Drive electron-updater's download + install. Emits Started/Progress/Finished
 * over UPDATER_DOWNLOAD_CHANNEL so the shim's downloadAndInstall(onEvent) can
 * relay them to UpdateBanner.svelte, then quitAndInstall(). Best-effort: if the
 * updater is unconfigured (dev), emit a synthetic Finished so the UI doesn't
 * hang, and let the renderer fall through to its manual-restart toast.
 *
 * Leak-safety: every electron-updater listener we attach is torn down in a
 * single finally via removeAllListeners on the channels we touched.
 */
async function runDownloadAndInstall(ctx: HandlerCtx): Promise<null> {
  const au = getAutoUpdater();
  if (!au) {
    // Nothing to download in dev — report instant completion. The renderer
    // then attempts relaunch(); failure there is handled by its own toast.
    const finished: DownloadEventPayload = { event: 'Finished' };
    ctx.emit(UPDATER_DOWNLOAD_CHANNEL, finished);
    return null;
  }

  if (downloading) {
    throw new Error('An update download is already in progress');
  }
  downloading = true;

  const emit = (p: DownloadEventPayload): void => ctx.emit(UPDATER_DOWNLOAD_CHANNEL, p);

  // We only want listeners scoped to THIS download. Clear any stragglers first.
  au.removeAllListeners('download-progress');
  au.removeAllListeners('update-downloaded');
  au.removeAllListeners('error');

  let lastTransferred = 0;
  let startedEmitted = false;

  const cleanup = (): void => {
    au.removeAllListeners('download-progress');
    au.removeAllListeners('update-downloaded');
    au.removeAllListeners('error');
    downloading = false;
  };

  try {
    await new Promise<void>((resolve, reject) => {
      au.on('download-progress', (...args: unknown[]) => {
        const p = args[0] as ProgressInfo;
        if (!startedEmitted) {
          startedEmitted = true;
          emit({ event: 'Started', data: { contentLength: p.total ?? 0 } });
        }
        // electron-updater reports cumulative `transferred`; the renderer sums
        // chunkLength, so translate cumulative -> per-chunk delta.
        const chunk = Math.max(0, (p.transferred ?? 0) - lastTransferred);
        lastTransferred = p.transferred ?? lastTransferred;
        if (chunk > 0) emit({ event: 'Progress', data: { chunkLength: chunk } });
      });

      au.on('update-downloaded', () => {
        emit({ event: 'Finished' });
        resolve();
      });

      au.on('error', (...args: unknown[]) => {
        reject(args[0] instanceof Error ? args[0] : new Error(errMsg(args[0])));
      });

      au.downloadUpdate().catch(reject);
    });
  } catch (err) {
    cleanup();
    emit({ event: 'Error', data: { message: errMsg(err) } });
    throw new Error(`Update download failed: ${errMsg(err)}`);
  }

  cleanup();

  // Install on next tick so the Finished event flushes to the renderer first.
  // isSilent=false (show installer), isForceRunAfter=true (relaunch after).
  setTimeout(() => {
    try {
      au.quitAndInstall(false, true);
    } catch (err) {
      console.warn('[updater] quitAndInstall failed:', errMsg(err));
    }
  }, 100);

  return null;
}

/**
 * Register the updater commands. The renderer reaches these via the
 * tauri-updater shim (check + the synthesized downloadAndInstall).
 */
export function register(handlers: HandlerMap, ctx: HandlerCtx): void {
  // __updater_check — tauri-updater shim entry. Returns UpdateInfo | null.
  handlers.set('__updater_check', async () => {
    return runCheck();
  });

  // __updater_download — drives downloadAndInstall + quitAndInstall. The shim's
  // synthesized Update.downloadAndInstall() invokes this, then listens on
  // UPDATER_DOWNLOAD_CHANNEL for Started/Progress/Finished/Error.
  handlers.set('__updater_download', async () => {
    return runDownloadAndInstall(ctx);
  });

  // Kick off the background "update available" notice (Rust check_and_notify).
  checkAndNotify(ctx);
}
