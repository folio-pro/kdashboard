// Event-channel subscriptions for the renderer:
//   - the callback receives an event object with a `.payload` field
//   - listen() resolves to an UnlistenFn that removes the subscription
//
// Backed by the preload bridge (window.electronAPI.on/off).

export type UnlistenFn = () => void;

/** Minimal event shape the UI relies on (only `.payload` is used). */
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
  // The preload's on() returns the unsubscribe for the exact listener it
  // registered. `fn` itself is a different object on each side of the context
  // bridge, so off(channel, fn) is only a fallback for a bridge that predates
  // that return value (the ambient ElectronAPI type in global.d.ts still says
  // void — hence the cast).
  const unsubscribe = window.electronAPI.on(channel, fn) as unknown;
  return () => {
    if (typeof unsubscribe === "function") unsubscribe();
    else window.electronAPI.off(channel, fn);
  };
}
