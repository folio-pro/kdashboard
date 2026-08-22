// The host side of the extension API: builds ExtensionContexts bound to the
// real registry and stores, and runs the loader at boot. Kept apart from
// loader.ts so the loader stays importable in tests without Svelte stores.

import { invoke } from "$lib/ipc/core";
import { open as shellOpen } from "$lib/ipc/shell";
import { k8sStore } from "$lib/stores/k8s.svelte";
import { settingsStore } from "$lib/stores/settings.svelte";
import { toastStore } from "$lib/stores/toast.svelte";
import { openRelatedResourceTab } from "$lib/actions/navigation";
import { extensions } from "./registry.svelte";
import { API_VERSION, type ExtensionContext } from "./api";
import { blobImporter, loadExtensions, type ExtensionSource, type ExtensionStatus } from "./loader";

/** Status of every discovered extension, for Settings → Extensions. Filled once at boot. */
export const extensionStatuses: ExtensionStatus[] = [];
/** Where the app looks for extensions (from the main process). */
export let extensionsDirectory = "";

function makeContext(id: string, registered: string[]): ExtensionContext {
  const prefix = `[ext:${id}]`;
  const storageKey = (k: string) => `${id}.${k}`;
  return {
    id,
    apiVersion: API_VERSION,
    registerAction: (a) => { extensions.registerAction(a); registered.push(`action ${a.label}`); },
    registerCommand: (c) => { extensions.registerCommand(c); registered.push(`command ${c.label}`); },
    registerSettingsTab: (t) => { extensions.registerSettingsTab(t); registered.push(`settings tab ${t.label}`); },
    registerMount: (m) => { extensions.registerMount(m); registered.push(`slot ${m.slot}`); },
    registerKbdHint: (h) => { extensions.registerKbdHint(h); registered.push(`hint ${h.label}`); },
    onStartup: (hook) => { extensions.onStartup(hook); registered.push("startup hook"); },
    on: (type, handler) => { extensions.on(type, handler); registered.push(`on ${type}`); },
    invoke: (command, args = {}) => invoke(command, args),
    cluster: {
      get context() { return k8sStore.currentContext; },
      get namespace() { return k8sStore.currentNamespace; },
      get selectedResource() { return k8sStore.selectedResource; },
    },
    toast: {
      success: (t, d) => { toastStore.success(t, d); },
      error: (t, d) => { toastStore.error(t, d); },
      warning: (t, d) => { toastStore.warning(t, d); },
      info: (t, d) => { toastStore.info(t, d); },
    },
    openResource: (resourceType, name, namespace) => openRelatedResourceTab(resourceType, name, namespace),
    openExternal: (url) => shellOpen(url),
    storage: {
      get: <T,>(key: string) => settingsStore.getExtensionValue(storageKey(key)) as T | undefined,
      set: (key, value) => settingsStore.setExtensionValue(storageKey(key), value),
    },
    log: {
      info: (m, ...r) => console.info(prefix, m, ...r),
      warn: (m, ...r) => console.warn(prefix, m, ...r),
      error: (m, ...r) => console.error(prefix, m, ...r),
    },
  };
}

/**
 * Discover and activate user extensions. Must run BEFORE `extensions.seal()`.
 * No bridge (plain browser dev server) or a failing list → nothing loads.
 */
export async function loadUserExtensions(): Promise<ExtensionStatus[]> {
  let sources: ExtensionSource[] = [];
  try {
    const result = await invoke<{ dir: string; extensions: ExtensionSource[] }>("list_extensions", {});
    if (result && Array.isArray(result.extensions)) {
      sources = result.extensions;
      extensionsDirectory = result.dir ?? "";
    }
  } catch {
    return extensionStatuses;
  }
  const statuses = await loadExtensions(sources, { importer: blobImporter, makeContext });
  extensionStatuses.splice(0, extensionStatuses.length, ...statuses);
  for (const s of statuses) {
    if (s.state !== "active") console.warn(`[extensions] ${s.id}: ${s.state} — ${s.error}`);
  }
  return extensionStatuses;
}
