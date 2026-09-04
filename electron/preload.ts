// Preload: the ONLY bridge between the sandboxed renderer and the Node main
// process. Exposes a minimal, typed surface as window.electronAPI. The
// renderer's IPC layer (src/lib/ipc/*) calls exclusively through this object so
// the Svelte UI never touches Node/Electron APIs directly.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

/** Callback registered via on()/off(). Mirrors Electron's listener signature. */
type Listener = (event: IpcRendererEvent, payload: unknown) => void;

const api = {
  /**
   * Persisted settings, read SYNCHRONOUSLY at boot.
   *
   * The renderer needs `theme_mode` before its first paint — an async invoke
   * would leave the document without a `data-theme` for a full IPC round-trip,
   * which is a visible flash on every light theme. This is the ONLY sync call
   * in the bridge; everything else stays async on purpose.
   *
   * Returns null if main has not registered the channel or the settings file is
   * unreadable; callers fall back to the async get_settings path.
   */
  bootSettings(): Record<string, unknown> | null {
    try {
      return ipcRenderer.sendSync('k8s:boot-settings') as Record<string, unknown> | null;
    } catch {
      return null;
    }
  },

  /**
   * Invoke a backend command. Returns a promise that resolves with the
   * handler's result or rejects with its Error. `cmd` is the snake_case
   * command string; `args` is the renderer-supplied arg object.
   */
  invoke(cmd: string, args: Record<string, unknown>): Promise<unknown> {
    return ipcRenderer.invoke('k8s:invoke', cmd, args);
  },

  /**
   * Subscribe to one of the backend event channels (terminal-output,
   * terminal-exit, log-lines, port-forward-closed, resource-watch-event, …).
   * src/lib/ipc/event.ts wraps the payload as { payload } before handing it to
   * the UI callback.
   *
   * Returns the unsubscribe. A renderer function crossing the context bridge
   * arrives here as a fresh proxy on EVERY call, so `off(channel, cb)` with
   * the "same" cb removes nothing — every watch (re)start left its previous
   * listener attached, and a dozen tabs later Node warned about 11
   * resource-watch-event listeners. The closure below holds the one proxy
   * that was actually registered, so removal cannot miss.
   */
  on(channel: string, cb: Listener): () => void {
    const listener: Listener = (event, payload) => cb(event, payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  /**
   * Remove a previously-registered channel listener. Only works for a `cb`
   * whose identity survived the bridge (it generally does not — see on());
   * prefer the unsubscribe on() returns.
   */
  off(channel: string, cb: Listener): void {
    ipcRenderer.removeListener(channel, cb);
  },

  /** Open a URL in the user's default browser (plugin-shell `open`). */
  openExternal(url: string): Promise<unknown> {
    return ipcRenderer.invoke('k8s:invoke', '__shell_open', { url });
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);

export type ElectronAPI = typeof api;
