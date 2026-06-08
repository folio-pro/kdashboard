// Shim for `@tauri-apps/plugin-updater`. The updater is migration phase 2, so
// check() always reports "no update" (null) for now. The Update type shape is
// preserved so UpdateBanner.svelte compiles unchanged: it reads `.version` and
// calls `.downloadAndInstall(onEvent)` where the event union is Started /
// Progress / Finished.

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

/**
 * Check for an available update. Phase 2 stub: resolves to null (no update).
 * Real implementation will return an Update handle backed by electron-updater.
 */
export async function check(): Promise<Update | null> {
  const result = await window.electronAPI.invoke('__updater_check', {});
  if (!result) return null;
  // Phase 2 will return a real Update handle here.
  return result as Update;
}
