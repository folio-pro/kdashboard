// Shim for `$lib/ipc/core`. Aliased in vite.config so the renderer's
// `import { invoke } from "$lib/ipc/core"` resolves here unchanged.
//
// Delegates to the preload bridge, which forwards to ipcMain.handle('k8s:invoke').

// ipcRenderer.invoke rejections arrive wrapped as
// "Error invoking remote method 'k8s:invoke': Error: <real message>" —
// transport noise the user should never see.
const IPC_WRAPPER = /^Error invoking remote method '[^']+': (?:Error: )?/;

/**
 * Deep-plain-clone an args object IF it contains a non-plain value (Svelte 5
 * $state proxies above all). ipcRenderer.invoke serializes with the structured
 * clone algorithm, which THROWS "An object could not be cloned" on any Proxy —
 * so e.g. passing `settingsStore.settings` (deep $state) made save_settings
 * fail on every call under Electron (Tauri JSON-serialized, masking this).
 * JSON round-trip is safe here: IPC payloads are plain JSON data by contract.
 * The common case (plain strings/numbers already) pays only a cheap scan.
 */
function toCloneable(args: Record<string, unknown>): Record<string, unknown> {
  for (const v of Object.values(args)) {
    if (typeof v === 'object' && v !== null) {
      return JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
    }
  }
  return args;
}

/**
 * Invoke a backend command. Mirrors Tauri's invoke<T>(cmd, args?) signature:
 * resolves with the handler's result, rejects with its Error message.
 */
export async function invoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return (await window.electronAPI.invoke(cmd, args ? toCloneable(args) : {})) as T;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(raw.replace(IPC_WRAPPER, ''));
  }
}
