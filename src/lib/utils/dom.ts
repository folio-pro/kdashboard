/** Check if a tag name + contentEditable combo indicates an input-like element. */
export function isInputLikeTag(tagName: string, isContentEditable: boolean): boolean {
  return (
    tagName === "INPUT" ||
    tagName === "TEXTAREA" ||
    tagName === "SELECT" ||
    isContentEditable
  );
}

/** Check if an event target is an input-like element that should capture keystrokes. */
export function isInputElement(target: EventTarget | null): boolean {
  if (!target || typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  return isInputLikeTag(target.tagName, target.isContentEditable);
}

/**
 * True while a modal or floating layer owns the keyboard: bits-ui dialogs,
 * popovers, select menus and dropdowns all mark their content
 * `data-state="open"` and close themselves on Escape. The global handler
 * used to fire on the same keypress and close the detail tab behind the
 * dialog the user was cancelling.
 */
export function overlayOpen(root: ParentNode | null = typeof document === "undefined" ? null : document): boolean {
  if (!root) return false;
  return (
    root.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [data-bits-floating-content], [data-menu-content], [role="menu"]',
    ) !== null
  );
}
