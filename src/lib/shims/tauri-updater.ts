// Shim for `@tauri-apps/plugin-updater`, backed by electron-updater via the
// Electron main process (electron/handlers/updater.ts).
//
// UpdateBanner.svelte (the only consumer) does:
//   const update = await check();              // null when no update
//   if (update) await update.downloadAndInstall(onEvent);  // Started/Progress/Finished
//   await relaunch();                          // tauri-process shim
//
// The backend returns plain JSON ({ version, body, date } | null) — it cannot
// carry a method — so the Update handle's downloadAndInstall() is synthesized
// HERE: it invokes __updater_download and relays the backend's
// `updater-download-event` channel into the onEvent callback the UI passes.

/** Download lifecycle events the UI's onEvent callback understands. */
export interface DownloadStartedEvent {
  event: 'Started';
  data: { contentLength?: number };
}
export interface DownloadProgressEvent {
  event: 'Progress';
  data: { chunkLength: number };
}
export interface DownloadFinishedEvent {
  event: 'Finished';
}
export type DownloadEvent =
  | DownloadStartedEvent
  | DownloadProgressEvent
  | DownloadFinishedEvent;

/** Mirror of Tauri's Update handle (only the bits UpdateBanner.svelte uses). */
export interface Update {
  version: string;
  downloadAndInstall(onEvent?: (event: DownloadEvent) => void): Promise<void>;
}

/** Raw UpdateInfo the backend returns (matches src/lib/types/settings.ts). */
interface BackendUpdateInfo {
  version: string;
  body: string | null;
  date: string | null;
}

/** Channel the backend emits download lifecycle events on. */
const DOWNLOAD_CHANNEL = 'updater-download-event';

/** Internal "Error" variant the backend may emit; surfaced as a thrown error. */
type BackendDownloadEvent = DownloadEvent | { event: 'Error'; data: { message: string } };

/**
 * Wrap a backend UpdateInfo in an Update handle whose downloadAndInstall()
 * invokes __updater_download and pumps the backend's download events into the
 * caller's onEvent callback. Resolves on Finished, rejects on Error.
 */
function makeUpdate(info: BackendUpdateInfo): Update {
  return {
    version: info.version,
    downloadAndInstall(onEvent?: (event: DownloadEvent) => void): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const listener = (_e: unknown, payload: unknown): void => {
          const ev = payload as BackendDownloadEvent;
          if (ev.event === 'Error') {
            cleanup();
            reject(new Error(ev.data.message));
            return;
          }
          onEvent?.(ev);
          if (ev.event === 'Finished') {
            cleanup();
            resolve();
          }
        };

        const cleanup = (): void => {
          window.electronAPI.off(DOWNLOAD_CHANNEL, listener);
        };

        window.electronAPI.on(DOWNLOAD_CHANNEL, listener);

        window.electronAPI.invoke('__updater_download', {}).catch((err) => {
          cleanup();
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      });
    },
  };
}

/**
 * Check for an available update. Resolves to null (no update) or an Update
 * handle. Backed by electron-updater; in an unconfigured dev run the backend
 * returns null gracefully.
 */
export async function check(): Promise<Update | null> {
  const result = (await window.electronAPI.invoke('__updater_check', {})) as
    | BackendUpdateInfo
    | null;
  if (!result || !result.version) return null;
  return makeUpdate(result);
}
