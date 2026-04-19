import { k8sStore } from "../stores/k8s.svelte.js";
import { uiStore } from "../stores/ui.svelte.js";
import { contextMenuStore } from "../stores/context-menu.svelte.js";
import { dialogStore } from "../stores/dialogs.svelte.js";
import { SCALABLE_TYPES } from "../actions/registry.js";

export { isInputElement } from "./dom.js";
import { isInputElement } from "./dom.js";

export function initKeyboardShortcuts(): () => void {
  function handleKeydown(e: KeyboardEvent): void {
    const meta = e.metaKey || e.ctrlKey;
    const isInput = isInputElement(e.target);

    // Cmd/Ctrl+K: Command palette (always active)
    if (meta && e.key === "k") {
      e.preventDefault();
      uiStore.toggleCommandPalette();
      return;
    }

    // Cmd/Ctrl+W: Close active tab
    if (meta && e.key === "w") {
      e.preventDefault();
      if (uiStore.activeTab?.closable) {
        uiStore.closeTab(uiStore.activeTabId);
      }
      return;
    }

    // Cmd/Ctrl+L: Show logs view (always active)
    if (meta && e.key === "l") {
      e.preventDefault();
      if (uiStore.activeView === "logs") {
        uiStore.backToPrevious();
      } else {
        uiStore.showLogs();
      }
      return;
    }

    // Cmd/Ctrl+T: Show terminal view (always active)
    if (meta && e.key === "t") {
      e.preventDefault();
      if (uiStore.activeView === "terminal") {
        uiStore.backToPrevious();
      } else {
        uiStore.showTerminal();
      }
      return;
    }

    // Escape: Close overlays / go back in priority order
    if (e.key === "Escape") {
      if (contextMenuStore.open) {
        contextMenuStore.close();
        return;
      }
      if (uiStore.commandPaletteOpen) {
        uiStore.commandPaletteOpen = false;
        return;
      }
      if (uiStore.activeView === "settings") {
        uiStore.backToPrevious();
        return;
      }
      // If in an input, blur it first
      if (isInput) {
        (e.target as HTMLElement).blur();
        return;
      }
      // From logs/terminal/yaml/details, close the tab
      if (uiStore.activeView === "logs" || uiStore.activeView === "terminal" || uiStore.activeView === "yaml") {
        if (uiStore.activeTab?.closable) uiStore.closeTab(uiStore.activeTabId);
        return;
      }
      if (uiStore.activeView === "details") {
        if (k8sStore.navigateBack()) return;
        k8sStore.selectResource(null);
        if (uiStore.activeTab?.closable) uiStore.closeTab(uiStore.activeTabId);
        return;
      }
      if (uiStore.activeView !== "table") {
        uiStore.backToTable();
        return;
      }
      if (uiStore.selectedRowIndex >= 0) {
        uiStore.resetSelection();
        return;
      }
      return;
    }

    // Cmd/Ctrl+,: Open settings (always active)
    if (meta && e.key === ",") {
      e.preventDefault();
      uiStore.toggleSettings();
      return;
    }

    // Skip other shortcuts if in an input
    if (isInput) return;

    // Cmd/Ctrl+B: Toggle sidebar
    if (meta && e.key === "b") {
      e.preventDefault();
      uiStore.toggleSidebar();
      return;
    }

    const view = uiStore.activeView;

    // --- Details view shortcuts ---
    if (view === "details") {
      const resource = k8sStore.selectedResource;
      const kind = resource?.kind?.toLowerCase();

      // e: Edit YAML
      if (e.key === "e") {
        e.preventDefault();
        uiStore.showYamlEditor();
        return;
      }

      // l: View logs (pods and deployments only)
      if (e.key === "l") {
        if (kind === "pod" || kind === "deployment") {
          e.preventDefault();
          uiStore.showLogs();
        }
        return;
      }

      // t: Open terminal (pods only)
      if (e.key === "t") {
        if (kind === "pod") {
          e.preventDefault();
          uiStore.showTerminal();
        }
        return;
      }

      // s: Scale workload (deployments, statefulsets, replicasets)
      if (e.key === "s") {
        const rt = kind + "s";
        if (resource && SCALABLE_TYPES.includes(rt)) {
          e.preventDefault();
          dialogStore.openScale(resource);
        }
        return;
      }

      return;
    }

    // --- Table view shortcuts ---
    if (view === "table") {
      // /: Focus the filter input
      if (e.key === "/") {
        e.preventDefault();
        const filterInput = document.getElementById("resource-filter");
        if (filterInput) {
          filterInput.focus();
        }
        return;
      }

      // r: Refresh resources
      if (e.key === "r") {
        e.preventDefault();
        k8sStore.refreshResources();
        return;
      }

      // j/k/ArrowDown/ArrowUp/Enter: handled by ResourceTable component
      return;
    }
  }

  window.addEventListener("keydown", handleKeydown);
  return () => window.removeEventListener("keydown", handleKeydown);
}
