// Shim for `@tauri-apps/api/core`. Aliased in vite.config so the renderer's
// `import { invoke } from "@tauri-apps/api/core"` resolves here unchanged.
//
// Delegates to the preload bridge, which forwards to ipcMain.handle('k8s:invoke').

/**
 * Invoke a backend command. Mirrors Tauri's invoke<T>(cmd, args?) signature:
 * resolves with the handler's result, rejects with its Error message.
 */
export async function invoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return window.electronAPI.invoke(cmd, args ?? {}) as Promise<T>;
}
