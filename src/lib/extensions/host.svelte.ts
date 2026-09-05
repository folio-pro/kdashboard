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

/** What Settings → Extensions shows. Filled once at boot, before mount. */
class ExtensionHostState {
  statuses = $state.raw<ExtensionStatus[]>([]);
  /** Where the app looks for extensions (from the main process). */
  directory = $state("");
}
export const extensionHost = new ExtensionHostState();

function makeLogger(prefix: string): ExtensionContext["log"] {
  return {
    info: (m, ...r) => console.info(prefix, m, ...r),
    warn: (m, ...r) => console.warn(prefix, m, ...r),
    error: (m, ...r) => console.error(prefix, m, ...r),
  };
}

function makeContext(id: string, registered: string[]): ExtensionContext {
  /** Forward to the registry and remember what was registered, for the Settings tab. */
  const track = <A extends unknown[]>(label: (...args: A) => string, fn: (...args: A) => void) =>
    (...args: A) => { fn(...args); registered.push(label(...args)); };
  return {
    id,
    apiVersion: API_VERSION,
    registerAction: track((a) => `action ${a.label}`, (a) => extensions.registerAction(a)),
    registerCommand: track((c) => `command ${c.label}`, (c) => extensions.registerCommand(c)),
    registerSettingsTab: track((t) => `settings tab ${t.label}`, (t) => extensions.registerSettingsTab(t)),
    registerMount: track((m) => `slot ${m.slot}`, (m) => extensions.registerMount(m)),
    registerKbdHint: track((h) => `hint ${h.label}`, (h) => extensions.registerKbdHint(h)),
    onStartup: (hook) => { extensions.onStartup(hook); registered.push("startup hook"); },
    on: (type, handler) => { extensions.on(type, handler); registered.push(`on ${type}`); },
    invoke: (command, args = {}) => invoke(command, args),
    cluster: {
      get context() { return k8sStore.currentContext; },
      get namespace() { return k8sStore.currentNamespace; },
      get selectedResource() { return k8sStore.selectedResource; },
    },
    toast: toastStore,
    openResource: (resourceType, name, namespace) => openRelatedResourceTab(resourceType, name, namespace),
    openExternal: (url) => shellOpen(url),
    storage: {
      get: <T,>(key: string) => settingsStore.getExtensionValue(`${id}.${key}`) as T | undefined,
      set: (key, value) => settingsStore.setExtensionValue(`${id}.${key}`, value),
    },
    log: makeLogger(`ext:${id}`),
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
      extensionHost.directory = result.dir ?? "";
    }
  } catch {
    return extensionHost.statuses;
  }
  extensionHost.statuses = await loadExtensions(sources, { importer: blobImporter, makeContext });
  for (const s of extensionHost.statuses) {
    if (s.state !== "active") console.warn(`[extensions] ${s.id}: ${s.state} — ${s.error}`);
  }
  return extensionHost.statuses;
}
