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

  registerStubHandlers(handlers);

  async function dispatch(cmd: string, args: Record<string, unknown> | undefined): Promise<unknown> {
    const handler = handlers.get(cmd);
    if (!handler) {
      throw new Error(`Unknown command: ${cmd}`);
    }
    return handler(args ?? {}, ctx);
  }

  return { handlers, dispatch };
}

/**
 * Streaming / stateful / updater commands that are NOT yet ported. Registered
 * only if a real handler module hasn't already claimed the name, so the Wire
 * and Port phases can override these by registering first. Each throws a clear
 * phase-2 error so the app still boots and the failure is legible in the UI.
 */
export const STUBBED_PHASE2_COMMANDS = [
  // Port forwarding (stateful sessions + port-forward-closed channel)
  'start_port_forward',
  'stop_port_forward',
  // Terminal exec (stateful PTY + terminal-output / terminal-exit channels)
  'start_terminal_exec',
  'stop_terminal_exec',
  'send_terminal_input',
  'resize_terminal',
  // Logs (streaming + log-lines channel)
  'stream_pod_logs',
  'stream_multi_pod_logs',
  'stop_log_stream',
  // Resource watch (streaming + resource-watch-event channel)
  'start_resource_watch',
  'stop_resource_watch',
] as const;

function registerStubHandlers(handlers: HandlerMap): void {
  for (const cmd of STUBBED_PHASE2_COMMANDS) {
    if (handlers.has(cmd)) continue; // a real module already claimed it
    handlers.set(cmd, () => {
      throw new Error('Not yet implemented — streaming subsystem, migration phase 2');
    });
  }
}
