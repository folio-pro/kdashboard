// Shim for `@tauri-apps/plugin-shell`. The renderer imports `{ open }`
// (named) in PortForwardView.svelte, PodPortForwarding.svelte and
// actions/registry.ts. Only `open` is used; back it with the preload bridge.

/** Open a URL (or path) in the OS default handler / browser. */
export async function open(url: string): Promise<void> {
  await window.electronAPI.openExternal(url);
}
