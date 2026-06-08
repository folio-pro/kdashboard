// Shim for `@tauri-apps/api/window`. Only the methods the renderer actually
// uses are implemented (grepped from src/):
//   - getCurrentWindow().setBadgeCount(n?)  (OverviewDashboard.svelte)
//   - show() / hide() are provided for App-level reveal/teardown parity.
//
// Each method is backed by an internal `__window_*` ipc command registered in
// electron/main.ts.

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
