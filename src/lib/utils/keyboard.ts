import { uiStore } from "../stores/ui.svelte.js";
import { SHORTCUTS, isActive } from "../shortcuts.js";

export { isInputElement } from "./dom.js";
import { isInputElement } from "./dom.js";

/**
 * Global key dispatcher. Holds no bindings of its own — every shortcut is
 * declared in `$lib/shortcuts`, which the status bar and the settings
 * reference read from too, so the three can no longer drift apart.
 */
export function initKeyboardShortcuts(): () => void {
  function handleKeydown(e: KeyboardEvent): void {
    const meta = e.metaKey || e.ctrlKey;
    const isInput = isInputElement(e.target);
    const view = uiStore.activeView;

    for (const s of SHORTCUTS) {
      if (s.handledElsewhere) continue;
      if (isInput && !s.allowInInput) continue;
      if (s.scope === "table" && view !== "table") continue;
      if (s.scope === "details" && view !== "details") continue;
      if (!s.match(e, meta)) continue;
      // Matched but gated off (e.g. `t` on a non-pod): swallow it rather than
      // letting a later entry claim the same key.
      if (!isActive(s)) return;
      e.preventDefault();
      s.run(e);
      return;
    }
  }

  window.addEventListener("keydown", handleKeydown);
  return () => window.removeEventListener("keydown", handleKeydown);
}
