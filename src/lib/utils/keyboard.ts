import { uiStore } from "../stores/ui.svelte.js";
import { SHORTCUTS, isActive } from "../shortcuts.js";

export { isInputElement } from "./dom.js";
import { isInputElement, overlayOpen } from "./dom.js";

/**
 * Global key dispatcher. Holds no bindings of its own — every shortcut is
 * declared in `$lib/shortcuts`, which the status bar and the settings
 * reference read from too, so the three can no longer drift apart.
 */
export function initKeyboardShortcuts(): () => void {
  // Whether a dialog / popover / menu was open when the Escape keydown
  // started. bits-ui closes its layer from a document-level listener, which
  // runs before this window-level one — by the time the shortcut dispatcher
  // saw the key the dialog was already gone, so "Esc = Back" also closed the
  // detail tab behind the dialog the user had just cancelled. Sampling in the
  // capture phase sees the layer while it is still open.
  let escapeClaimedByOverlay = false;
  function sampleOverlay(e: KeyboardEvent): void {
    if (e.key === "Escape") escapeClaimedByOverlay = overlayOpen();
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape" && (escapeClaimedByOverlay || e.defaultPrevented)) {
      escapeClaimedByOverlay = false;
      return;
    }
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

  window.addEventListener("keydown", sampleOverlay, true);
  window.addEventListener("keydown", handleKeydown);
  return () => {
    window.removeEventListener("keydown", sampleOverlay, true);
    window.removeEventListener("keydown", handleKeydown);
  };
}
