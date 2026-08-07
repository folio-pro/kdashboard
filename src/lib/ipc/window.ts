// Shim for `$lib/ipc/window`. Only the methods the renderer actually
// uses are implemented (grepped from src/):
//   - getCurrentWindow().setBadgeCount(n?)  (OverviewDashboard.svelte)
//   - show() / hide() are provided for App-level reveal/teardown parity.
//
// Each method is backed by an internal `__window_*` ipc command registered in
// electron/main.ts.

// Mark the OS on <html> so the custom title bar CSS can reserve space for the
// macOS traffic lights (see app.css `[data-os="macos"]`). Runs once on import;
// App.svelte imports this shim at startup, before the TitleBar renders.
if (typeof document !== 'undefined' && typeof navigator !== 'undefined') {
  const isMac =
    navigator.userAgent.includes('Macintosh') || navigator.platform?.startsWith('Mac');
  document.documentElement.dataset.os = isMac ? 'macos' : 'other';
}

interface ShimWindow {
  /** Set the dock/taskbar badge count; pass undefined/0 to clear. */
  setBadgeCount(count?: number): Promise<void>;
  /** Show the main window. */
  show(): Promise<void>;
  /** Hide the main window. */
  hide(): Promise<void>;
}

export function getCurrentWindow(): ShimWindow {
  return {
    async setBadgeCount(count?: number): Promise<void> {
      await window.electronAPI.invoke('__window_set_badge_count', {
        count: count ?? 0,
      });
    },
    async show(): Promise<void> {
      await window.electronAPI.invoke('__window_show', {});
    },
    async hide(): Promise<void> {
      await window.electronAPI.invoke('__window_hide', {});
    },
  };
}

// Tauri also exports getCurrentWebviewWindow as an alias in some versions; keep
// it available so any future import resolves.
export const getCurrentWebviewWindow = getCurrentWindow;
