import type { ActionDef } from "$lib/actions/types";
import type { CommandPaletteItem } from "$lib/types/ui";
import type {
  AppEvent,
  AppEventType,
  EventHandler,
  KbdHint,
  SettingsTab,
  SlotMount,
  SlotName,
  StartupHook,
} from "./types";

class ExtensionRegistry {
  #actions = $state<ActionDef[]>([]);
  #commands = $state<CommandPaletteItem[]>([]);
  #tabs = $state<SettingsTab[]>([]);
  #mounts = $state<SlotMount[]>([]);
  #hints = $state<KbdHint[]>([]);
  #startupHooks: StartupHook[] = [];
  #eventHandlers = new Map<AppEventType, Array<(e: AppEvent) => void | Promise<void>>>();
  #sealed = false;

  // ---------------------------------------------------------------------
  // Registration (producers call these before seal())
  // ---------------------------------------------------------------------

  registerAction(action: ActionDef): void {
    this.#guard("registerAction");
    if (this.#actions.some((x) => x.id === action.id)) {
      throw new Error(`Duplicate action id: ${action.id}`);
    }
    this.#actions.push(action);
  }

  registerCommand(command: CommandPaletteItem): void {
    this.#guard("registerCommand");
    if (this.#commands.some((x) => x.id === command.id)) {
      throw new Error(`Duplicate command id: ${command.id}`);
    }
    this.#commands.push(command);
  }

  registerSettingsTab(tab: SettingsTab): void {
    this.#guard("registerSettingsTab");
    if (this.#tabs.some((x) => x.id === tab.id)) {
      throw new Error(`Duplicate settings tab id: ${tab.id}`);
    }
    this.#tabs.push(tab);
  }

  registerMount<S extends SlotName>(mount: SlotMount<S>): void {
    this.#guard("registerMount");
    if (this.#mounts.some((x) => x.id === mount.id)) {
      throw new Error(`Duplicate mount id: ${mount.id}`);
    }
    this.#mounts.push(mount as unknown as SlotMount);
  }

  registerKbdHint(hint: KbdHint): void {
    this.#guard("registerKbdHint");
    if (this.#hints.some((x) => x.id === hint.id)) {
      throw new Error(`Duplicate hint id: ${hint.id}`);
    }
    this.#hints.push(hint);
  }

  onStartup(hook: StartupHook): void {
    this.#guard("onStartup");
    this.#startupHooks.push(hook);
  }

  on<T extends AppEventType>(type: T, handler: EventHandler<T>): void {
    this.#guard("on");
    const list = this.#eventHandlers.get(type) ?? [];
    list.push(handler as (e: AppEvent) => void | Promise<void>);
    this.#eventHandlers.set(type, list);
  }

  // ---------------------------------------------------------------------
  // Reads (core components call these during render)
  // ---------------------------------------------------------------------

  get actions(): ReadonlyArray<ActionDef> {
    return this.#actions;
  }

  get commands(): ReadonlyArray<CommandPaletteItem> {
    return this.#commands;
  }

  get tabs(): ReadonlyArray<SettingsTab> {
    return this.#tabs.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  get kbdHints(): ReadonlyArray<KbdHint> {
    return this.#hints.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  mountsFor<S extends SlotName>(slot: S): ReadonlyArray<SlotMount<S>> {
    const filtered = this.#mounts
      .filter((m) => m.slot === slot)
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return filtered as unknown as ReadonlyArray<SlotMount<S>>;
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  async runStartupHooks(): Promise<void> {
    for (const hook of this.#startupHooks) {
      await hook();
    }
  }

  async emit(event: AppEvent): Promise<void> {
    const handlers = this.#eventHandlers.get(event.type) ?? [];
    for (const handler of handlers) {
      await handler(event);
    }
  }

  seal(): void {
    this.#sealed = true;
  }

  get isSealed(): boolean {
    return this.#sealed;
  }

  #guard(operation: string): void {
    if (this.#sealed) {
      throw new Error(
        `Extensions registry is sealed — ${operation} must run before the app mounts`,
      );
    }
  }
}

export const extensions = new ExtensionRegistry();
