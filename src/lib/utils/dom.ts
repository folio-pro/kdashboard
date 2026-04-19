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
