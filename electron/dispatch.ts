// Central command dispatcher for the Electron backend.
//
// The renderer (Svelte UI) calls invoke(cmd, args) through the Tauri shim,
// which forwards to window.electronAPI.invoke -> ipcMain.handle('k8s:invoke').
// That handler delegates here. Each handler module under electron/handlers/
// exports a `register(handlers, ctx)` function that populates the Map with
// the EXACT Tauri command strings (snake_case) used by the frontend.

import type { BrowserWindow } from 'electron';

/**
 * Context handed to every handler. `emit` pushes an event to the renderer over
 * one of the 5 event channels (terminal-output, terminal-exit, log-lines,
 * port-forward-closed, resource-watch-event); `mainWindow` returns the live
 * main BrowserWindow (or null before it is created).
 */
export interface HandlerCtx {
  emit(channel: string, payload: unknown): void;
  mainWindow(): BrowserWindow | null;
}

/**
 * A single command handler. Receives the args object the renderer passed to
 * invoke() (keys are exactly what the frontend sends — often camelCase) plus
 * the shared ctx. Must return a JSON-serializable value matching the Rust
 * return shape, or throw new Error(message) to reject the renderer promise.
 */
export type Handler = (args: Record<string, unknown>, ctx: HandlerCtx) => Promise<unknown> | unknown;

export type HandlerMap = Map<string, Handler>;

/**
 * Shape of a handler module: `register` mutates the shared map. The Wire phase
 * imports every module and calls its register() during app bootstrap.
 */
export interface HandlerModule {
  register(handlers: HandlerMap, ctx: HandlerCtx): void;
}

/**
 * Build the dispatch Map by running each module's register() hook, then return
 * a `dispatch(cmd, args)` callable bound to that map.
 */
export function buildDispatcher(modules: HandlerModule[], ctx: HandlerCtx): {
  handlers: HandlerMap;
  dispatch: (cmd: string, args: Record<string, unknown> | undefined) => Promise<unknown>;
} {
  const handlers: HandlerMap = new Map();

  for (const mod of modules) {
    mod.register(handlers, ctx);
  }

  async function dispatch(cmd: string, args: Record<string, unknown> | undefined): Promise<unknown> {
    const handler = handlers.get(cmd);
    if (!handler) {
      throw new Error(`Unknown command: ${cmd}`);
    }
    return handler(args ?? {}, ctx);
  }

  return { handlers, dispatch };
}
