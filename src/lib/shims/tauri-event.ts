// Shim for `@tauri-apps/api/event`. Preserves Tauri's listen() contract:
//   - the callback receives an event object with a `.payload` field
//   - listen() resolves to an UnlistenFn that removes the subscription
//
// Backed by the preload bridge (window.electronAPI.on/off).

export type UnlistenFn = () => void;

/** Minimal Tauri event shape the UI relies on (only `.payload` is used). */
export interface Event<T> {
  payload: T;
}

export type EventCallback<T> = (event: Event<T>) => void;

/**
 * Subscribe to a backend event channel. The returned promise resolves with an
 * UnlistenFn; call it to stop receiving events.
 */
export async function listen<T = unknown>(
  channel: string,
  cb: EventCallback<T>,
): Promise<UnlistenFn> {
  const fn = (_e: unknown, payload: unknown): void => cb({ payload: payload as T });
  window.electronAPI.on(channel, fn);
  return () => window.electronAPI.off(channel, fn);
}
