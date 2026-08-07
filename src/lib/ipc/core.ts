// Shim for `$lib/ipc/core`. Aliased in vite.config so the renderer's
// `import { invoke } from "$lib/ipc/core"` resolves here unchanged.
//
// Delegates to the preload bridge, which forwards to ipcMain.handle('k8s:invoke').

// ipcRenderer.invoke rejections arrive wrapped as
// "Error invoking remote method 'k8s:invoke': Error: <real message>" —
// transport noise the user should never see.
const IPC_WRAPPER = /^Error invoking remote method '[^']+': (?:Error: )?/;

/**
 * Invoke a backend command. Mirrors Tauri's invoke<T>(cmd, args?) signature:
 * resolves with the handler's result, rejects with its Error message.
 */
export async function invoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return (await window.electronAPI.invoke(cmd, args ?? {})) as T;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(raw.replace(IPC_WRAPPER, ''));
  }
}
