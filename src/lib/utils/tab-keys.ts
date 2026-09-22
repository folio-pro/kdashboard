/**
 * Key → tab-switch decoding for the tab shortcuts in `$lib/shortcuts`. Pure,
 * so it is unit-testable without the Svelte stores the registry imports.
 *
 *   Ctrl+Tab / Ctrl+Shift+Tab   next / previous (Ctrl on every platform)
 *   ⌘⇧] / ⌘⇧[                   next / previous
 *   ⌘1 … ⌘8                     tab N
 *   ⌘9                          last tab
 *
 * ⌘ is Cmd on macOS and Ctrl elsewhere, like every other ⌘ shortcut.
 */

export type TabSwitch = "next" | "previous" | { index: number };

type KeyLike = Pick<
  KeyboardEvent,
  "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
>;

export function tabSwitchFor(e: KeyLike): TabSwitch | null {
  if (e.altKey) return null;

  if (e.key === "Tab") {
    if (!e.ctrlKey || e.metaKey) return null;
    return e.shiftKey ? "previous" : "next";
  }

  if (!(e.metaKey || e.ctrlKey)) return null;

  // Physical key codes: e.key for ⌘⇧] is "}" on US layouts and something else
  // on others, and digits sit behind Shift on AZERTY.
  if (e.shiftKey) {
    if (e.code === "BracketRight") return "next";
    if (e.code === "BracketLeft") return "previous";
    return null;
  }

  const digit = /^Digit([1-9])$/.exec(e.code);
  if (!digit) return null;
  const n = Number(digit[1]);
  return { index: n === 9 ? -1 : n - 1 };
}
