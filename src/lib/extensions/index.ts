export { extensions } from "./registry.svelte";
export { defineExtension, API_VERSION } from "./api";
export type { ExtensionContext, ExtensionModule } from "./api";
export type {
  ActionDef,
  AppEvent,
  AppEventType,
  EventHandler,
  KbdHint,
  SettingsTab,
  SlotMount,
  SlotName,
  SlotProps,
  StartupHook,
} from "./types";
export type { CommandPaletteItem as PaletteCommand } from "$lib/types/ui";
