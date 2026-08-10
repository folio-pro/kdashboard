// Ambient declaration for the preload-exposed bridge. Lets the @tauri-apps/*
// modules (and any src/ code) reference window.electronAPI with full typing.
//
// Keep this in sync with electron/preload.ts (ElectronAPI).

export {};

declare global {
  interface ElectronAPI {
    /**
     * Persisted settings, read synchronously so the theme can be applied before
     * the first paint. Null when unavailable — fall back to `get_settings`.
     */
    bootSettings(): Record<string, unknown> | null;
    /** Invoke a backend command; resolves with the handler result or rejects with its Error. */
    invoke(cmd: string, args: Record<string, unknown>): Promise<unknown>;
    /** Subscribe to a backend event channel. */
    on(channel: string, cb: (event: unknown, payload: unknown) => void): void;
    /** Unsubscribe a previously-registered channel listener (same fn reference). */
    off(channel: string, cb: (event: unknown, payload: unknown) => void): void;
    /** Open a URL in the default browser. */
    openExternal(url: string): Promise<unknown>;
  }

  interface Window {
    electronAPI: ElectronAPI;
  }
}
