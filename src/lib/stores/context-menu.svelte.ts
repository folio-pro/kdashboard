// WARNING: Do NOT import uiStore here — ui.svelte.ts imports this module.
import type { MenuContext } from "$lib/actions/types";

class ContextMenuStore {
  open = $state(false);
  x = $state(0);
  y = $state(0);
  context = $state<MenuContext | null>(null);

  show(x: number, y: number, context: MenuContext): void {
    this.x = x;
    this.y = y;
    this.context = context;
    this.open = true;
  }

  close(): void {
    this.open = false;
    this.context = null;
  }
}

export const contextMenuStore = new ContextMenuStore();
