// Shim for `@tauri-apps/plugin-process`. The renderer imports `{ exit }`
// (benchmark/e2e-runner.ts) and `{ relaunch }` (UpdateBanner.svelte). Both are
// backed by internal ipc commands that call app.exit / app.relaunch in main.

/** Exit the app with the given status code (default 0). */
export async function exit(code = 0): Promise<void> {
  await window.electronAPI.invoke('__process_exit', { code });
}

/** Relaunch the app (used after an update install). */
export async function relaunch(): Promise<void> {
  await window.electronAPI.invoke('__process_relaunch', {});
}
