// The public extension API — the contract a user extension is written
// against. Everything an extension may touch goes through `ExtensionContext`;
// the rest of the app is deliberately out of reach. Bump API_VERSION when a
// change would break an existing extension.

import type { ActionDef } from "$lib/actions/types";
import type { CommandPaletteItem, Resource } from "$lib/types";
import type { AppEventType, EventHandler, KbdHint, SettingsTab, SlotMount, SlotName, StartupHook } from "./types";

export const API_VERSION = 1;

export interface ExtensionLogger {
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
}

/** What an extension receives in `activate()`. */
export interface ExtensionContext {
  readonly id: string;
  readonly apiVersion: number;
  /** Registry — available until the app mounts (registrations after that throw). */
  registerAction(action: ActionDef): void;
  registerCommand(command: CommandPaletteItem): void;
  registerSettingsTab(tab: SettingsTab): void;
  registerMount<S extends SlotName>(mount: SlotMount<S>): void;
  registerKbdHint(hint: KbdHint): void;
  onStartup(hook: StartupHook): void;
  on<T extends AppEventType>(type: T, handler: EventHandler<T>): void;
  /** Cluster access: the same IPC the app uses (`list_resources`, `get_resource`, …). */
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
  /** Read-only view of the connection. */
  readonly cluster: {
    readonly context: string;
    readonly namespace: string;
    readonly selectedResource: Resource | null;
  };
  /** Notifications in the app's own toast stack (returns the toast id). */
  toast: {
    success(title: string, description?: string): string;
    error(title: string, description?: string): string;
    warning(title: string, description?: string): string;
    info(title: string, description?: string): string;
  };
  /** Open a resource's detail tab (fetches it first). */
  openResource(resourceType: string, name: string, namespace?: string): Promise<void>;
  /** Open an external URL in the system browser. */
  openExternal(url: string): Promise<void>;
  /** Extension-scoped persistent key/value (stored in settings under `extensions.<id>`). */
  storage: {
    get<T = unknown>(key: string): T | undefined;
    set(key: string, value: unknown): void;
  };
  log: ExtensionLogger;
}

/** The default export of an extension's entry module. */
export interface ExtensionModule {
  id?: string;
  /** Called once, before the app mounts. Register here. */
  activate(ctx: ExtensionContext): void | Promise<void>;
  /** Optional: called when the app is unloading. */
  deactivate?(): void | Promise<void>;
}

/** Identity helper so an extension can be written as `export default defineExtension({...})` with types. */
export function defineExtension(mod: ExtensionModule): ExtensionModule {
  return mod;
}
